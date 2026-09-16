import pino, { Logger, Level } from "pino";

export interface AgentLogger extends Logger {
  child(bindings: Record<string, unknown>): AgentLogger;
}

let loggerInstance: AgentLogger | null = null;

export function createLogger(options: {
  level?: Level;
  logFile?: string;
  pretty?: boolean;
}): AgentLogger {
  const transports: pino.TransportTargetOptions[] = [];
  
  if (options.pretty !== false) {
    transports.push({
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "HH:MM:ss Z",
        ignore: "pid,hostname",
      },
    });
  }

  if (options.logFile) {
    transports.push({
      target: "pino/file",
      options: { destination: options.logFile, mkdir: true },
    });
  }

  const logger = pino({
    level: options.level || "info",
    transport: transports.length > 0 ? { targets: transports } : undefined,
    base: { service: "gh-agent" },
    timestamp: pino.stdTimeFunctions.isoTime,
  }) as AgentLogger;

  loggerInstance = logger;
  return logger;
}

export function getLogger(): AgentLogger {
  if (!loggerInstance) {
    return createLogger({ level: "info" });
  }
  return loggerInstance;
}

export function setLogger(logger: AgentLogger): void {
  loggerInstance = logger;
}