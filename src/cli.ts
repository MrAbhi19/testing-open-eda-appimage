import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { runAgent, AgentOptions } from "./agent.js";
import { listConversations } from "./conversation.js";

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "run";

  // Load configuration first
  const config = await loadConfig();

  // Create logger
  const logger = createLogger({
    level: config.logLevel,
    logFile: config.logFile,
    pretty: !config.logFile,
  });

  logger.info({ version: "2.0.0", command }, "gh-agent starting");

  try {
    switch (command) {
      case "run": {
        const prompt = process.env.PROMPT || args[1];
        if (!prompt) {
          logger.error("PROMPT is required. Set PROMPT env var or pass as argument.");
          process.exit(1);
        }

        const options: AgentOptions = {
          prompt,
          config,
          logger,
        };

        const result = await runAgent(options);
        
        logger.info({ 
          success: result.success,
          iterations: result.iterations,
          totalTokens: result.totalTokens,
          estimatedCost: result.estimatedCost,
          conversationId: result.conversationId,
        }, "Agent run completed");

        if (result.summary) {
          console.log("\n=== SUMMARY ===");
          console.log(result.summary);
        }

        process.exit(result.success ? 0 : 1);
      }

      case "history": {
        const conversations = await listConversations(config.conversationDir);
        console.log("\nConversation History:");
        console.log("=".repeat(80));
        for (const conv of conversations.slice(0, 20)) {
          console.log(`ID: ${conv.id}`);
          console.log(`  Prompt: ${conv.prompt.slice(0, 80)}...`);
          console.log(`  Model: ${conv.model}`);
          console.log(`  Status: ${conv.status}`);
          console.log(`  Iterations: ${conv.iterations}`);
          console.log(`  Tokens: ${conv.totalTokens || 0}`);
          console.log(`  Cost: $${(conv.estimatedCost || 0).toFixed(6)}`);
          console.log(`  Started: ${conv.startedAt}`);
          console.log();
        }
        break;
      }

      case "config": {
        console.log("\nCurrent Configuration:");
        console.log("=".repeat(40));
        console.log(JSON.stringify(config, null, 2));
        break;
      }

      default:
        logger.error({ command }, "Unknown command");
        console.log("Usage: gh-agent [run|history|config] [prompt]");
        process.exit(1);
    }
  } catch (error: any) {
    logger.fatal({ error: error.message, stack: error.stack }, "Agent failed");
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on("SIGINT", () => {
  console.log("\nReceived SIGINT, shutting down gracefully...");
  process.exit(130);
});

process.on("SIGTERM", () => {
  console.log("\nReceived SIGTERM, shutting down gracefully...");
  process.exit(143);
});

main();