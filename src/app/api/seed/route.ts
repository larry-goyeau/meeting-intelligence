import fs from "node:fs/promises";
import path from "node:path";
import { config } from "@/lib/config";
import { failure, HttpError, ok } from "@/lib/api";
import { ingestTranscript } from "@/lib/rag/ingest";
import { Repository } from "@/lib/store/repository";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Loads the bundled sample corpus. Exposed as an endpoint rather than only a CLI
 * script so a reviewer can populate the app from the empty state with one click
 * and never touch a terminal.
 */
export async function POST() {
  try {
    let filenames: string[];
    try {
      filenames = await fs.readdir(config.sampleDir);
    } catch {
      throw new HttpError(500, `Sample transcripts are missing from ${config.sampleDir}.`);
    }

    const transcripts = filenames.filter((name) => /\.(txt|md|vtt|srt)$/i.test(name)).sort();
    if (transcripts.length === 0) throw new HttpError(500, "No sample transcripts found.");

    const repository = new Repository();
    const ingested = [];
    let reused = 0;
    for (const filename of transcripts) {
      const content = await fs.readFile(path.join(config.sampleDir, filename), "utf8");
      const result = await ingestTranscript({ filename, content, source: "sample" }, repository);
      if (result.reused) reused += 1;
      ingested.push(result.meeting);
    }

    return ok({ ingested, reused }, { status: 201 });
  } catch (error) {
    return failure(error);
  }
}
