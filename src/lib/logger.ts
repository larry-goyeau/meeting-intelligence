import { config } from "./config";

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_COLOR: Record<Level, string> = {
  debug: "\u001b[90m",
  info: "\u001b[36m",
  warn: "\u001b[33m",
  error: "\u001b[31m",
};

/**
 * Structured logging with a correlation id per request. JSON in production so a
 * log pipeline can index it; a readable line locally. Deliberately tiny: a real
 * deployment would swap this for OpenTelemetry (see README, productionisation).
 */
export interface Logger {
  traceId: string;
  child(fields: Record<string, unknown>): Logger;
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

function emit(level: Level, traceId: string, base: Record<string, unknown>, event: string, fields?: Record<string, unknown>) {
  const record = { ts: new Date().toISOString(), level, traceId, event, ...base, ...fields };
  if (config.observability.logFormat === "json") {
    process.stdout.write(`${JSON.stringify(record)}\n`);
    return;
  }
  const { ts, ...rest } = record;
  const detail = Object.entries(rest)
    .filter(([key]) => !["level", "event", "traceId"].includes(key))
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" ");
  const time = ts.slice(11, 23);
  process.stdout.write(`${LEVEL_COLOR[level]}${level.padEnd(5)}\u001b[0m ${time} \u001b[90m${traceId.slice(0, 8)}\u001b[0m ${event} ${detail}\n`);
}

export function createLogger(traceId = crypto.randomUUID(), base: Record<string, unknown> = {}): Logger {
  return {
    traceId,
    child: (fields) => createLogger(traceId, { ...base, ...fields }),
    debug: (event, fields) => emit("debug", traceId, base, event, fields),
    info: (event, fields) => emit("info", traceId, base, event, fields),
    warn: (event, fields) => emit("warn", traceId, base, event, fields),
    error: (event, fields) => emit("error", traceId, base, event, fields),
  };
}

/** Times a pipeline stage and records it, so the UI can show where latency went. */
export async function timed<T>(
  collector: { stage: string; ms: number; detail?: Record<string, unknown> }[],
  stage: string,
  fn: () => Promise<T>,
  detail?: (result: T) => Record<string, unknown>,
): Promise<T> {
  const started = performance.now();
  try {
    const result = await fn();
    collector.push({ stage, ms: Math.round(performance.now() - started), detail: detail?.(result) });
    return result;
  } catch (error) {
    collector.push({ stage, ms: Math.round(performance.now() - started), detail: { failed: true } });
    throw error;
  }
}
