type LogContext = Record<string, unknown>;

function write(level: "info" | "warn" | "error", event: string, context: LogContext = {}): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...context
  };
  const output = JSON.stringify(entry);
  if (level === "error") console.error(output);
  else if (level === "warn") console.warn(output);
  else console.log(output);
}

export const logger = {
  info(event: string, context?: LogContext): void {
    write("info", event, context);
  },
  warn(event: string, context?: LogContext): void {
    write("warn", event, context);
  },
  error(event: string, context?: LogContext): void {
    write("error", event, context);
  }
};

export function errorDetails(error: unknown): { errorName: string; errorMessage: string } {
  return error instanceof Error
    ? { errorName: error.name, errorMessage: error.message }
    : { errorName: "UnknownError", errorMessage: String(error) };
}

export function causeDetails(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return {};
  const cause = error.cause;
  if (cause instanceof Error) return { causeName: cause.name, causeMessage: cause.message };
  if (cause) return { cause: String(cause) };
  return {};
}

export async function loggedStage<T>(runId: string, stage: string, operation: () => Promise<T>, context: LogContext = {}): Promise<T> {
  const startedAt = Date.now();
  logger.info("stage.started", { runId, stage, ...context });
  try {
    const result = await operation();
    logger.info("stage.completed", { runId, stage, durationMs: Date.now() - startedAt, ...context });
    return result;
  } catch (error) {
    logger.error("stage.failed", { runId, stage, durationMs: Date.now() - startedAt, ...context, ...errorDetails(error) });
    throw error;
  }
}
