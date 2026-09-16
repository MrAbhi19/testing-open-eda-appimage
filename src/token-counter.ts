import { encoding_for_model, Tiktoken } from "tiktoken";

let encodingCache: Map<string, Tiktoken> = new Map();

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface CumulativeUsage extends TokenUsage {
  requests: number;
  estimatedCost: number;
}

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "nvidia/nemotron-nano-9b-v2:free": { input: 0, output: 0 },
  "nvidia/nemotron-3-ultra-550b-a55b:free": { input: 0, output: 0 },
  "anthropic/claude-3.5-sonnet": { input: 3.0, output: 15.0 },
  "openai/gpt-4o": { input: 2.5, output: 10.0 },
  "openai/gpt-4o-mini": { input: 0.15, output: 0.6 },
  "google/gemini-pro-1.5": { input: 3.5, output: 10.5 },
};

function getEncoding(model: string): Tiktoken {
  if (!encodingCache.has(model)) {
    try {
      const enc = encoding_for_model(model);
      encodingCache.set(model, enc);
    } catch {
      // Fallback to cl100k_base for unknown models
      const enc = encoding_for_model("gpt-4");
      encodingCache.set(model, enc);
    }
  }
  return encodingCache.get(model)!;
}

export function countTokens(text: string, model: string): number {
  const enc = getEncoding(model);
  return enc.encode(text).length;
}

export function countMessageTokens(messages: Array<{ role: string; content?: string | null; tool_calls?: any[] }>, model: string): number {
  const enc = getEncoding(model);
  let total = 0;
  
  for (const msg of messages) {
    // Base overhead per message
    total += 4; // role + content overhead
    
    if (msg.content) {
      total += countTokens(msg.content, model);
    }
    
    if (msg.tool_calls) {
      for (const call of msg.tool_calls) {
        total += countTokens(JSON.stringify(call.function), model);
      }
    }
  }
  
  total += 2; // Conversation overhead
  return total;
}

export function estimateCost(usage: TokenUsage, model: string): number {
  const pricing = MODEL_PRICING[model] || { input: 0, output: 0 };
  return (usage.promptTokens * pricing.input + usage.completionTokens * pricing.output) / 1_000_000;
}

export class TokenTracker {
  private model: string;
  private budget: number;
  private usage: CumulativeUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    requests: 0,
    estimatedCost: 0,
  };

  constructor(model: string, budget: number) {
    this.model = model;
    this.budget = budget;
  }

  addUsage(usage: TokenUsage): void {
    this.usage.promptTokens += usage.promptTokens;
    this.usage.completionTokens += usage.completionTokens;
    this.usage.totalTokens += usage.totalTokens;
    this.usage.requests += 1;
    this.usage.estimatedCost = estimateCost(this.usage, this.model);
  }

  getUsage(): CumulativeUsage {
    return { ...this.usage };
  }

  getRemainingBudget(): number {
    return this.budget - this.usage.totalTokens;
  }

  getBudgetUtilization(): number {
    return this.usage.totalTokens / this.budget;
  }

  isBudgetExceeded(): boolean {
    return this.usage.totalTokens >= this.budget;
  }

  canFit(additionalTokens: number): boolean {
    return this.usage.totalTokens + additionalTokens <= this.budget;
  }

  reset(): void {
    this.usage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      requests: 0,
      estimatedCost: 0,
    };
  }
}