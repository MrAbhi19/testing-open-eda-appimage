import { z } from "zod";
import fs from "node:fs/promises";
import yaml from "yaml";

export const ConfigSchema = z.object({
  model: z.string().default("nvidia/nemotron-nano-9b-v2:free"),
  maxIterations: z.number().int().positive().default(20),
  apiDelayMs: z.number().int().nonnegative().default(5000),
  retryDelayMs: z.number().int().nonnegative().default(30000),
  maxRetries: z.number().int().positive().default(5),
  maxTokens: z.number().int().positive().default(128000),
  tokenBudget: z.number().int().positive().default(100000),
  logLevel: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  logFile: z.string().optional(),
  persistConversation: z.boolean().default(true),
  conversationDir: z.string().default(".agent/conversations"),
  rateLimit: z
    .object({
      requestsPerMinute: z.number().int().positive().default(10),
      tokensPerMinute: z.number().int().positive().default(50000),
    })
    .default({ requestsPerMinute: 10, tokensPerMinute: 50000 }),
  toolTimeoutMs: z.number().int().positive().default(30000),
  enableStreaming: z.boolean().default(false),
  systemPrompt: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export async function loadConfig(
  env: Record<string, string | undefined> = process.env
): Promise<Config> {
  const candidates = [
    env.CONFIG_FILE,
    ".agent/config.yaml",
    "config.yaml",
  ].filter(Boolean) as string[];

  let fileConfig: Record<string, unknown> = {};
  for (const p of candidates) {
    try {
      const content = await fs.readFile(p, "utf8");
      fileConfig = (yaml.parse(content) as Record<string, unknown>) || {};
      break;
    } catch {
      // try next candidate
    }
  }

  const envConfig: Record<string, unknown> = {};
  const set = (
    key: string,
    raw: string | undefined,
    coerce: (v: string) => unknown = (v) => v
  ) => {
    if (raw !== undefined && raw !== "") envConfig[key] = coerce(raw);
  };

  set("model", env.MODEL);
  set("maxIterations", env.MAX_ITER, Number);
  set("apiDelayMs", env.API_DELAY_MS, Number);
  set("retryDelayMs", env.RETRY_DELAY_MS, Number);
  set("maxRetries", env.MAX_RETRIES, Number);
  set("maxTokens", env.MAX_TOKENS, Number);
  set("tokenBudget", env.TOKEN_BUDGET, Number);
  set("logLevel", env.LOG_LEVEL);
  set("logFile", env.LOG_FILE);
  set("persistConversation", env.PERSIST_CONVERSATION, (v) => v === "true");
  set("conversationDir", env.CONVERSATION_DIR);
  set("toolTimeoutMs", env.TOOL_TIMEOUT_MS, Number);
  set("enableStreaming", env.ENABLE_STREAMING, (v) => v === "true");
  set("systemPrompt", env.SYSTEM_PROMPT);

  const rl: Record<string, unknown> = {};
  if (env.RATE_LIMIT_RPM) rl.requestsPerMinute = Number(env.RATE_LIMIT_RPM);
  if (env.RATE_LIMIT_TPM) rl.tokensPerMinute = Number(env.RATE_LIMIT_TPM);
  if (Object.keys(rl).length > 0) envConfig.rateLimit = rl;

  const merged = {
    ...fileConfig,
    ...envConfig,
    rateLimit: {
      ...((fileConfig.rateLimit as object) || {}),
      ...((envConfig.rateLimit as object) || {}),
    },
  };

  return ConfigSchema.parse(merged);
}
