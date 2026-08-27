import { NextResponse } from "next/server";
import type { ZodType } from "zod";
import { createLogger } from "./logger";

/**
 * HTTP plumbing shared by the route handlers, so no handler invents its own
 * error shape and the client only ever has to understand one.
 */

export class HttpError extends Error {
  readonly status: number;
  readonly detail: unknown;

  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.detail = detail;
  }
}

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

export function failure(error: unknown) {
  const logger = createLogger();
  if (error instanceof HttpError) {
    logger.warn("http.client_error", { status: error.status, message: error.message });
    return NextResponse.json({ error: error.message, detail: error.detail ?? null }, { status: error.status });
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  logger.error("http.server_error", { message, stack: error instanceof Error ? error.stack?.slice(0, 800) : undefined });
  // The message is passed through because this is a self-hosted tool for its own
  // data; a multi-tenant deployment would return an opaque id and log the detail.
  return NextResponse.json({ error: message }, { status: 500 });
}

export async function parseBody<T>(request: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new HttpError(422, "Request body failed validation.", result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })));
  }
  return result.data;
}

/**
 * Newline-delimited JSON rather than SSE. The pipeline emits three event shapes
 * with structured payloads; NDJSON carries those without escaping games, and
 * `fetch` + a stream reader on the client is less code than EventSource plus a
 * separate channel for the metadata.
 */
export function ndjsonStream(source: AsyncGenerator<{ type: string; data: unknown }>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of source) {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Stream failed";
        controller.enqueue(encoder.encode(`${JSON.stringify({ type: "error", data: { message } })}\n`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      // Without this, a reverse proxy will happily buffer the whole answer and
      // destroy the streaming experience.
      "X-Accel-Buffering": "no",
    },
  });
}
