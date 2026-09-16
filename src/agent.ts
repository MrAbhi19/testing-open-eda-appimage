import OpenAI from "openai";
import { loadConfig, Config } from "./config.js";
import { createLogger, getLogger, AgentLogger } from "./logger.js";
import { TokenBucketRateLimiter, createRateLimiter } from "./rate-limiter.js";
import { TokenTracker, countMessageTokens, TokenUsage } from "./token-counter.js";
import { runTool, toolDefinitions, ToolResult } from "./tools.js";
import { 
  createConversation, 
  addMessage, 
  updateConversationStatus, 
  saveConversation,
  Conversation 
} from "./conversation.js";

export interface AgentOptions {
  prompt: string;
  config?: Partial<Config>;
  logger?: AgentLogger;
}

export interface AgentResult {
  success: boolean;
  summary?: string;
  iterations: number;
  totalTokens: number;
  estimatedCost: number;
  conversationId: string;
}

export class Agent {
  private config: Config;
  private logger: AgentLogger;
  private client: OpenAI;
  private rateLimiter: TokenBucketRateLimiter;
  private tokenTracker: TokenTracker;
  private conversation: Conversation;
  private abortSignal: AbortSignal | null = null;

  constructor(options: AgentOptions) {
    this.config = options.config as Config;
    this.logger = options.logger || getLogger();
    this.client = new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: process.env.OPENROUTER_API_KEY!,
    });
    this.rateLimiter = createRateLimiter(this.config.rateLimit);
    this.tokenTracker = new TokenTracker(this.config.model, this.config.tokenBudget);
    this.conversation = createConversation(options.prompt, this.config.model);
  }

  setAbortSignal(signal: AbortSignal): void {
    this.abortSignal = signal;
  }

  private checkAbort(): void {
    if (this.abortSignal?.aborted) {
      throw new Error("Agent aborted");
    }
  }

  private async makeApiCall(messages: any[], iteration: number) {
    this.checkAbort();
    
    // Estimate tokens for rate limiting
    const estimatedTokens = countMessageTokens(messages, this.config.model) + 1000;
    await this.rateLimiter.acquire(1, estimatedTokens);

    const startTime = Date.now();
    let attempt = 0;

    while (attempt < this.config.maxRetries) {
      this.checkAbort();
      attempt++;
      
      try {
        this.logger.debug({ iteration, attempt, model: this.config.model }, "Making API call");
        
        const res = await this.client.chat.completions.create({
          model: this.config.model,
          messages,
          tools: toolDefinitions,
          tool_choice: "auto",
          stream: this.config.enableStreaming,
        });

        const latency = Date.now() - startTime;
        this.logger.info({ iteration, attempt, latencyMs: latency }, "API call succeeded");
        
        return res;
      } catch (error: any) {
        const status = error?.status;
        const latency = Date.now() - startTime;
        
        this.logger.warn({ iteration, attempt, status, latencyMs: latency, error: error?.message }, "API call failed");
        
        if ((status === 429 || status === 502 || status === 503) && attempt < this.config.maxRetries) {
          const delay = this.config.retryDelayMs * attempt; // Exponential backoff
          this.logger.info({ delayMs: delay }, "Retrying after delay");
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        
        throw error;
      }
    }
    
    throw new Error("Max retries exceeded");
  }

  private async processToolCalls(toolCalls: any[], messages: any[]): Promise<{ done: boolean; summary?: string }> {
    for (const call of toolCalls) {
      this.checkAbort();
      
      const args = JSON.parse(call.function.arguments || "{}");
      this.logger.info({ tool: call.function.name, args }, "Executing tool");
      
      const result: ToolResult = await runTool(call.function.name, args);
      
      if (!result.success) {
        this.logger.error({ tool: call.function.name, error: result.content }, "Tool execution failed");
      }
      
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result.content.slice(0, 8000),
      });
      
      addMessage(this.conversation, {
        role: "tool",
        content: result.content,
        tool_call_id: call.id,
      }, this.conversation.metadata.iterations);

      if (result.isDone) {
        return { done: true, summary: result.summary };
      }
    }
    
    return { done: false };
  }

  async run(): Promise<AgentResult> {
    if (!process.env.OPENROUTER_API_KEY) {
      throw new Error("OPENROUTER_API_KEY environment variable is required");
    }

    const systemPrompt = this.config.systemPrompt || 
      "You are an autonomous coding agent working inside a git repo. " +
      "You can read, write, and delete files using tools. " +
      "Work step by step. Prefer small, focused changes. " +
      "When finished, call the `done` tool with a summary. " +
      "Do not ask the user questions — make reasonable assumptions and proceed.";

    const messages: any[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: this.conversation.metadata.prompt },
    ];

    addMessage(this.conversation, { role: "system", content: systemPrompt });
    addMessage(this.conversation, { role: "user", content: this.conversation.metadata.prompt });

    this.logger.info({ 
      prompt: this.conversation.metadata.prompt.slice(0, 100),
      model: this.config.model,
      maxIterations: this.config.maxIterations,
    }, "Starting agent run");

    for (let i = 0; i < this.config.maxIterations; i++) {
      this.checkAbort();
      this.conversation.metadata.iterations = i + 1;
      
      this.logger.info({ iteration: i + 1 }, "Starting iteration");
      
      // Check token budget
      const currentTokens = countMessageTokens(messages, this.config.model);
      if (!this.tokenTracker.canFit(currentTokens + 1000)) {
        this.logger.warn({ currentTokens, budget: this.config.tokenBudget }, "Token budget exceeded");
        updateConversationStatus(this.conversation, "failed", this.tokenTracker.getUsage().totalTokens, this.tokenTracker.getUsage().estimatedCost);
        await this.persistConversation();
        return {
          success: false,
          iterations: i,
          totalTokens: this.tokenTracker.getUsage().totalTokens,
          estimatedCost: this.tokenTracker.getUsage().estimatedCost,
          conversationId: this.conversation.metadata.id,
        };
      }

      // Respect API delay
      if (this.config.apiDelayMs > 0) {
        this.logger.debug({ delayMs: this.config.apiDelayMs }, "Waiting before API call");
        await new Promise(r => setTimeout(r, this.config.apiDelayMs));
      }

      let response;
      try {
        response = await this.makeApiCall(messages, i + 1);
      } catch (error: any) {
        this.logger.error({ error: error.message }, "API call failed after retries");
        updateConversationStatus(this.conversation, "failed", this.tokenTracker.getUsage().totalTokens, this.tokenTracker.getUsage().estimatedCost);
        await this.persistConversation();
        return {
          success: false,
          iterations: i,
          totalTokens: this.tokenTracker.getUsage().totalTokens,
          estimatedCost: this.tokenTracker.getUsage().estimatedCost,
          conversationId: this.conversation.metadata.id,
        };
      }

      if (!response?.choices?.length) {
        this.logger.warn("No choices in response");
        continue;
      }

      const msg = response.choices[0].message;
      messages.push(msg);
      addMessage(this.conversation, {
        role: "assistant",
        content: msg.content,
        tool_calls: msg.tool_calls,
      }, i + 1);

      // Track token usage
      if (response.usage) {
        const usage: TokenUsage = {
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
          totalTokens: response.usage.total_tokens,
        };
        this.tokenTracker.addUsage(usage);
        this.logger.info({ usage, total: this.tokenTracker.getUsage() }, "Token usage");
      }

      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        this.logger.warn("Agent stopped without calling done");
        if (msg.content) {
          this.logger.info({ content: msg.content.slice(0, 200) }, "Final message");
        }
        updateConversationStatus(this.conversation, "completed", this.tokenTracker.getUsage().totalTokens, this.tokenTracker.getUsage().estimatedCost);
        await this.persistConversation();
        return {
          success: true,
          summary: msg.content || "Completed without explicit done call",
          iterations: i + 1,
          totalTokens: this.tokenTracker.getUsage().totalTokens,
          estimatedCost: this.tokenTracker.getUsage().estimatedCost,
          conversationId: this.conversation.metadata.id,
        };
      }

      const { done, summary } = await this.processToolCalls(msg.tool_calls, messages);
      
      if (done) {
        this.logger.info({ summary }, "Agent completed");
        updateConversationStatus(this.conversation, "completed", this.tokenTracker.getUsage().totalTokens, this.tokenTracker.getUsage().estimatedCost);
        await this.persistConversation();
        return {
          success: true,
          summary,
          iterations: i + 1,
          totalTokens: this.tokenTracker.getUsage().totalTokens,
          estimatedCost: this.tokenTracker.getUsage().estimatedCost,
          conversationId: this.conversation.metadata.id,
        };
      }

      // Persist conversation periodically
      if (this.config.persistConversation && (i + 1) % 5 === 0) {
        await this.persistConversation();
      }
    }

    this.logger.warn("Max iterations reached");
    updateConversationStatus(this.conversation, "max_iterations", this.tokenTracker.getUsage().totalTokens, this.tokenTracker.getUsage().estimatedCost);
    await this.persistConversation();
    
    return {
      success: false,
      summary: "Hit max iterations",
      iterations: this.config.maxIterations,
      totalTokens: this.tokenTracker.getUsage().totalTokens,
      estimatedCost: this.tokenTracker.getUsage().estimatedCost,
      conversationId: this.conversation.metadata.id,
    };
  }

  private async persistConversation(): Promise<void> {
    if (this.config.persistConversation) {
      try {
        await saveConversation(this.conversation, this.config.conversationDir);
        this.logger.debug({ id: this.conversation.metadata.id }, "Conversation persisted");
      } catch (error: any) {
        this.logger.warn({ error: error.message }, "Failed to persist conversation");
      }
    }
  }

  getConversation(): Conversation {
    return this.conversation;
  }

  getTokenUsage() {
    return this.tokenTracker.getUsage();
  }
}

export async function runAgent(options: AgentOptions): Promise<AgentResult> {
  const agent = new Agent(options);
  return agent.run();
}