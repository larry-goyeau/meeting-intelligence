import { failure, ok } from "@/lib/api";
import { getSystemStatus } from "@/lib/status";

export const dynamic = "force-dynamic";

/**
 * Liveness plus enough state to render the UI's status bar in one call: which
 * provider is active, how big the index is, and the retrieval settings in force.
 * A container orchestrator can use it as a health probe; a human can use it to
 * answer "why are the answers bad" without reading logs.
 */
export async function GET() {
  try {
    return ok(getSystemStatus().status);
  } catch (error) {
    return failure(error);
  }
}
