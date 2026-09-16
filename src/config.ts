import { z } from "zod";

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
  rateLimit: z.object({
    requestsPerMinute: z.number().int().positive().default(10),
    tokensPerMinute: z.number().int().positive().default(50000),
  }).default({}),
  toolTimeoutMs: z.number().int().positive().default(30000),
  enableStreaming: z.boolean().default(false),
  systemPrompt: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export async function loadConfig(env: Record<string, string | undefined> = process.env): Promise<Config> {
  const configFile = env.CONFIG_FILE || ".agent/config.yaml";
  
  let fileConfig: Partial<Config> = {};
  try {
    const fs = await import("node:fs/promises");
    const yaml = await import("yaml");
    const content = await fs.readFile(configFile, "utf8");
    fileConfig = yaml.parse(content) || {};
  } catch {
    // Config file is optional
  }

  const envConfig: Partial<Config> = {
    model: env.MODEL,
    maxIterations: env.MAX_ITER ? Number(env.MAX_ITER) : undefined,
    apiDelayMs: env.API_DELAY_MS ? Number(env.API_DELAY_MS) : undefined,
    retryDelayMs: env.RETRY_DELAY_MS ? Number(env.RETRY_DELAY_MS) : undefined,
    maxRetries: env.MAX_RETRIES ? Number(env.MAX_RETRIES) : undefined,
    maxTokens: env.MAX_TOKENS ? Number(env.MAX_TOKENS) : undefined,
    tokenBudget: env.TOKEN_BUDGET ? Number(env.TOKEN_BUDGET) : undefined,
    logLevel: env.LOG_LEVEL as Config["logLevel"],
    logFile: env.LOG_FILE,
    persistConversation: env.PERSIST_CONVERSATION ? env.PERSIST_CONVERSATION === "true" : undefined,
    conversationDir: env.CONVERSATION_DIR,
    toolTimeoutMs: env.TOOL_TIMEOUT_MS ? Number(env.TOOL_TIMEOUT_MS) : undefined,
    enableStreaming: env.ENABLE_STREAMING ? env.ENABLE_STREAMING === "true" : undefined,
    systemPrompt: env.SYSTEM_PROMPT,
    rateLimit: {
      requestsPerMinute: env.RATE_LIMIT_RPM ? Number(env.RATE_LIMIT_RPM) : undefined,
      tokensPerMinute: env.RATE_LIMIT_TPM ? Number(env.RATE_LIMIT_TPM) : undefined,
    },
  };

  // Remove undefined values
  Object.keys(envConfig).forEach(key => {
    if (envConfig[key as keyof Config] === undefined) {
      delete envConfig[key as keyof Config];
    }
  });
  
  if (envConfig.rateLimit) {
    Object.keys(envConfig.rateLimit).forEach(key => {
      if (envConfig.rateLimit?.[key as keyof typeof envConfig.rateLimit] === undefined) {
        delete envConfig.rateLimit[key as keyof typeof envConfig.rateLimit];
      }
    });
  }

  const merged = { ...fileConfig, ...envConfig };
  return ConfigSchema.parse(merged);
}