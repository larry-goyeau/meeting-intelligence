import { z } from "zod";
import { failure, HttpError, ok, parseBody } from "@/lib/api";
import { ingestTranscript, IngestError } from "@/lib/rag/ingest";
import { Repository } from "@/lib/store/repository";

export const dynamic = "force-dynamic";
/** Embedding a long transcript can outlive the default serverless budget. */
export const maxDuration = 300;

export async function GET() {
  try {
    return ok({ meetings: new Repository().listMeetings() });
  } catch (error) {
    return failure(error);
  }
}

const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;

const uploadSchema = z.object({
  filename: z.string().min(1).max(200),
  content: z.string().min(1),
  title: z.string().max(200).optional(),
  date: z.string().max(40).optional(),
});

/**
 * Accepts either multipart (the drag-and-drop path, possibly several files) or a
 * JSON body (the paste-a-transcript path and the seed script). Both land in the
 * same ingestion function.
 */
export async function POST(request: Request) {
  try {
    const repository = new Repository();
    const contentType = request.headers.get("content-type") ?? "";

    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const files = form.getAll("files").filter((entry): entry is File => entry instanceof File);
      if (files.length === 0) throw new HttpError(400, "No files were uploaded.");

      const results = [];
      const errors = [];
      for (const file of files) {
        if (file.size > MAX_TRANSCRIPT_BYTES) {
          errors.push({ filename: file.name, error: `File is ${Math.round(file.size / 1024)} KB; the limit is 4 MB.` });
          continue;
        }
        try {
          const content = await file.text();
          // One bad file out of five must not lose the other four.
          const result = await ingestTranscript({ filename: file.name, content, source: "upload" }, repository);
          results.push(result);
        } catch (error) {
          errors.push({ filename: file.name, error: error instanceof Error ? error.message : "Ingestion failed" });
        }
      }
      if (results.length === 0 && errors.length > 0) {
        throw new HttpError(422, errors[0]?.error ?? "Ingestion failed", errors);
      }
      return ok({ ingested: results.map((result) => result.meeting), reused: results.filter((r) => r.reused).length, errors }, { status: 201 });
    }

    const body = await parseBody(request, uploadSchema);
    if (Buffer.byteLength(body.content, "utf8") > MAX_TRANSCRIPT_BYTES) {
      throw new HttpError(413, "Transcript exceeds the 4 MB limit.");
    }
    const result = await ingestTranscript({ ...body, source: "upload" }, repository);
    return ok({ ingested: [result.meeting], reused: result.reused ? 1 : 0, errors: [] }, { status: 201 });
  } catch (error) {
    if (error instanceof IngestError) return failure(new HttpError(422, error.message));
    return failure(error);
  }
}
