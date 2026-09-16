import OpenAI from "openai";
import { Config } from "./config.js";
import { getLogger, AgentLogger } from "./logger.js";
import { TokenBucketRateLimiter, createRateLimiter } from "./rate-limiter.js";
import { TokenTracker, countMessageTokens, TokenUsage } from "./token-counter.js";
import { runTool, toolDefinitions, ToolResult } from "./tools.js";
import {
  createConversation,
  addMessage,
  updateConversationStatus,
  saveConversation,
  Conversation,
} from "./conversation.js";

export interface AgentOptions {
  prompt: string;
  config: Config;
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
    this.config = options.config;
    this.logger = options.logger || getLogger();
    this.client = new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: process.env.OPENROUTER_API_KEY!,
    });
    this.rateLimiter = createRateLimiter(this.config.rateLimit);
    this.tokenTracker = new TokenTracker(this.config.model, this.config.tokenBudget);
    this.conversation = createConversation(options.prompt, this.config.model);
  }

  setAbortSignal(signal: AbortSignal) {
    this.abortSignal = signal;
  }

  private checkAbort() {
    if (this.abortSignal?.aborted) throw new Error("Agent aborted");
  }

  private async makeApiCall(messages: any[], iteration: number) {
    this.checkAbort();

    const estimatedTokens = countMessageTokens(messages, this.config.model) + 1000;
    await this.rateLimiter.acquire(1, estimatedTokens);

    const startTime = Date.now();
    let attempt = 0;

    while (attempt < this.config.maxRetries) {
      this.checkAbort();
      attempt++;
      try {
        this.logger.debug({ iteration, attempt }, "Making API call");
        const res = await this.client.chat.completions.create({
          model: this.config.model,
          messages,
          tools: toolDefinitions,
          tool_choice: "auto",
          stream: this.config.enableStreaming,
        } as any);

        this.logger.info(
          { iteration, attempt, latencyMs: Date.now() - startTime },
          "API call succeeded"
        );
        return res;
      } catch (error: any) {
        const status = error?.status;
        this.logger.warn(
          { iteration, attempt, status, error: error?.message },
          "API call failed"
        );
        if (
          (status === 429 || status === 502 || status === 503) &&
          attempt < this.config.maxRetries
        ) {
          const delay = this.config.retryDelayMs * attempt;
          this.logger.info({ delayMs: delay }, "Retrying after delay");
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw error;
      }
    }
    throw new Error("Max retries exceeded");
  }

  private async processToolCalls(
    toolCalls: any[],
    messages: any[]
  ): Promise<{ done: boolean; summary?: string }> {
    for (const call of toolCalls) {
      this.checkAbort();
      const args = JSON.parse(call.function.arguments || "{}");
      this.logger.info({ tool: call.function.name, args }, "Executing tool");

      const result: ToolResult = await runTool(
        call.function.name,
        args,
        this.config.toolTimeoutMs
      );

      if (!result.success) {
        this.logger.error(
          { tool: call.function.name, error: result.content },
          "Tool execution failed"
        );
      }

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result.content.slice(0, 8000),
      });

      addMessage(
        this.conversation,
        { role: "tool", content: result.content, tool_call_id: call.id },
        this.conversation.metadata.iterations
      );

      if (result.isDone) return { done: true, summary: result.summary };
    }
    return { done: false };
  }

  async run(): Promise<AgentResult> {
    if (!process.env.OPENROUTER_API_KEY) {
      throw new Error("OPENROUTER_API_KEY environment variable is required");
    }

    const systemPrompt =
      this.config.systemPrompt ||
      "You are an autonomous coding agent working inside a git repo. " +
        "You can read, write, and delete files, and you can run whitelisted shell " +
        "commands (npm install / run typecheck / test, npx tsc, git status/diff). " +
        "IMPORTANT: after every code change, run `npm run typecheck` and fix any errors " +
        "before finishing. If you add an import, update package.json via write_file " +
        "and run `npm install` to verify. Work step by step. Prefer small, focused " +
        "changes. When finished, call the `done` tool with a summary of what you " +
        "changed and what you verified. Do not ask questions — make reasonable " +
        "assumptions and proceed.";

    const messages: any[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: this.conversation.metadata.prompt },
    ];
    addMessage(this.conversation, { role: "system", content: systemPrompt });
    addMessage(this.conversation, { role: "user", content: this.conversation.metadata.prompt });

    this.logger.info(
      {
        prompt: this.conversation.metadata.prompt.slice(0, 100),
        model: this.config.model,
        maxIterations: this.config.maxIterations,
      },
      "Starting agent run"
    );

    for (let i = 0; i < this.config.maxIterations; i++) {
      this.checkAbort();
      this.conversation.metadata.iterations = i + 1;
      this.logger.info({ iteration: i + 1 }, "Starting iteration");

      const currentTokens = countMessageTokens(messages, this.config.model);
      if (!this.tokenTracker.canFit(currentTokens + 1000)) {
        this.logger.warn({ currentTokens }, "Token budget exceeded");
        updateConversationStatus(
          this.conversation,
          "failed",
          this.tokenTracker.getUsage().totalTokens,
          this.tokenTracker.getUsage().estimatedCost
        );
        await this.persistConversation();
        return {
          success: false,
          iterations: i,
          totalTokens: this.tokenTracker.getUsage().totalTokens,
          estimatedCost: this.tokenTracker.getUsage().estimatedCost,
          conversationId: this.conversation.metadata.id,
        };
      }

      if (this.config.apiDelayMs > 0) {
        await new Promise((r) => setTimeout(r, this.config.apiDelayMs));
      }

      let response: any;
      try {
        response = await this.makeApiCall(messages, i + 1);
      } catch (error: any) {
        this.logger.error({ error: error.message }, "API call failed after retries");
        updateConversationStatus(
          this.conversation,
          "failed",
          this.tokenTracker.getUsage().totalTokens,
          this.tokenTracker.getUsage().estimatedCost
        );
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
      addMessage(
        this.conversation,
        { role: "assistant", content: msg.content, tool_calls: msg.tool_calls },
        i + 1
      );

      if (response.usage) {
        const usage: TokenUsage = {
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
          totalTokens: response.usage.total_tokens,
        };
        this.tokenTracker.addUsage(usage);
        this.logger.info({ usage }, "Token usage");
      }

      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        updateConversationStatus(
          this.conversation,
          "completed",
          this.tokenTracker.getUsage().totalTokens,
          this.tokenTracker.getUsage().estimatedCost
        );
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
        updateConversationStatus(
          this.conversation,
          "completed",
          this.tokenTracker.getUsage().totalTokens,
          this.tokenTracker.getUsage().estimatedCost
        );
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

      if (this.config.persistConversation && (i + 1) % 5 === 0) {
        await this.persistConversation();
      }
    }

    this.logger.warn("Max iterations reached");
    updateConversationStatus(
      this.conversation,
      "max_iterations",
      this.tokenTracker.getUsage().totalTokens,
      this.tokenTracker.getUsage().estimatedCost
    );
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

  private async persistConversation() {
    if (this.config.persistConversation) {
      try {
        await saveConversation(this.conversation, this.config.conversationDir);
      } catch (error: any) {
        this.logger.warn({ error: error.message }, "Failed to persist conversation");
      }
    }
  }

  getConversation() {
    return this.conversation;
  }
  getTokenUsage() {
    return this.tokenTracker.getUsage();
  }
}

export async function runAgent(options: AgentOptions): Promise<AgentResult> {
  return new Agent(options).run();
}
