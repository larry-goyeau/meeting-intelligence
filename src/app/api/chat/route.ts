import { z } from "zod";
import { failure, ndjsonStream, parseBody } from "@/lib/api";
import { ask } from "@/lib/rag/answer";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const chatSchema = z.object({
  question: z.string().min(1).max(4000),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() }))
    .max(40)
    .default([]),
  /** Empty means the whole corpus. */
  meetingIds: z.array(z.string()).max(100).default([]),
});

export async function POST(request: Request) {
  try {
    const body = await parseBody(request, chatSchema);
    return ndjsonStream(ask(body));
  } catch (error) {
    return failure(error);
  }
}
