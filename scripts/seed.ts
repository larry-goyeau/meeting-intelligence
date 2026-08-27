/**
 * Loads the bundled sample transcripts into the local database.
 *
 * Same code path as the UI button, exposed as a script so `docker compose up`
 * and CI can populate a corpus without a browser.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../src/lib/config";
import { providerSummary } from "../src/lib/providers";
import { ingestTranscript } from "../src/lib/rag/ingest";
import { Repository } from "../src/lib/store/repository";

async function main() {
  const provider = providerSummary();
  console.log(`Provider: ${provider.id} (chat ${provider.chatModel}, embeddings ${provider.embeddingModel})`);
  if (!provider.remote) {
    console.log("No OPENAI_API_KEY set: using deterministic offline embeddings and heuristic briefs.\n");
  }

  const filenames = (await fs.readdir(config.sampleDir)).filter((name) => /\.(txt|md|vtt|srt)$/i.test(name)).sort();
  if (filenames.length === 0) {
    console.error(`No transcripts found in ${config.sampleDir}`);
    process.exit(1);
  }

  const repository = new Repository();
  for (const filename of filenames) {
    const content = await fs.readFile(path.join(config.sampleDir, filename), "utf8");
    const started = Date.now();
    const result = await ingestTranscript({ filename, content, source: "sample" }, repository);
    const status = result.reused ? "already indexed" : `${result.meeting.turnCount} turns, ${result.meeting.chunkCount} chunks`;
    console.log(`  ${result.reused ? "=" : "+"} ${result.meeting.title.padEnd(42)} ${status} (${Date.now() - started} ms)`);
    for (const warning of result.warnings) console.log(`      warning: ${warning}`);
  }

  console.log(`\nCorpus: ${repository.listMeetings().length} meetings, ${repository.countChunks()} chunks in ${config.dbPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
