import { failure, HttpError, ok } from "@/lib/api";
import { Repository } from "@/lib/store/repository";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

/** Full meeting including turns, which is what the transcript viewer renders. */
export async function GET(_request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const meeting = new Repository().getMeeting(id);
    if (!meeting) throw new HttpError(404, "No meeting with that id.");
    return ok({ meeting });
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { id } = await params;
    // Chunks and embeddings go with it: the schema declares ON DELETE CASCADE and
    // foreign keys are enabled, so there is no orphan-cleanup path to forget.
    const deleted = new Repository().deleteMeeting(id);
    if (!deleted) throw new HttpError(404, "No meeting with that id.");
    return ok({ deleted: id });
  } catch (error) {
    return failure(error);
  }
}
