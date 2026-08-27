import { failure, ok } from "@/lib/api";
import { Repository } from "@/lib/store/repository";

export const dynamic = "force-dynamic";

/**
 * Every answered question is stored with its rewritten query, its sources, its
 * stage timings, its token usage and its guardrail verdict. This endpoint is what
 * the trace inspector reads, and it is the difference between "the answer looks
 * wrong" and "the answer looks wrong because lexical search returned nothing and
 * the dense hit was a neighbour".
 */
export async function GET(request: Request) {
  try {
    const limit = Number(new URL(request.url).searchParams.get("limit") ?? 25);
    const traces = new Repository().listTraces(Number.isFinite(limit) ? Math.min(limit, 200) : 25);
    return ok({ traces });
  } catch (error) {
    return failure(error);
  }
}
