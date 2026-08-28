/**
 * Relevance-gate calibration.
 *
 * The gate's two thresholds are the only numbers in the system that must be set
 * per embedding model: "unrelated" sits at a different cosine similarity in every
 * embedding space. Guessing them, or fitting them to the one case that happens to
 * fail, is how a refusal gate ends up either never firing or refusing real
 * questions. This prints both signals for every evaluation case plus extra
 * out-of-corpus questions, so a threshold can be chosen where the two populations
 * actually separate.
 *
 * Usage: npm run gate
 */
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../src/lib/config";
import { providerSummary } from "../src/lib/providers";
import { ingestTranscript } from "../src/lib/rag/ingest";
import { retrieve } from "../src/lib/rag/retrieve";
import { createMemoryDb } from "../src/lib/store/db";
import { Repository } from "../src/lib/store/repository";

/** Questions this corpus genuinely cannot answer. Deliberately varied in how close they sit to it. */
const OUT_OF_CORPUS = [
  "What is the company's parental leave policy?",
  "How many vacation days do employees get?",
  "What is the office wifi password?",
  "Who won the football match last night?",
  "What is our policy on reimbursing bicycle commuting costs?",
  "What did we decide about the Kubernetes migration?",
  "Which vendor did we pick for payroll?",
  "What is the revenue target for next year?",
];

async function main() {
  const provider = providerSummary();
  console.log(`provider ${provider.id} — ${provider.embeddingModel} (${provider.embeddingDimensions}d)`);
  console.log(
    `thresholds: minDense=${config.retrieval.minDenseSimilarity} strongDense=${config.retrieval.strongDenseSimilarity} minCoverage=${config.retrieval.minQueryCoverage}\n`,
  );

  const repository = new Repository(createMemoryDb());
  const filenames = (await fs.readdir(config.sampleDir)).filter((name) => /\.(txt|md|vtt|srt)$/i.test(name)).sort();
  for (const filename of filenames) {
    const content = await fs.readFile(path.join(config.sampleDir, filename), "utf8");
    await ingestTranscript({ filename, content, source: "sample" }, repository);
  }

  const golden = JSON.parse(await fs.readFile(path.join(process.cwd(), "data/eval/golden.json"), "utf8")) as {
    cases: { question: string; expectRefusal?: boolean }[];
  };

  const probes = [
    ...golden.cases.map((c) => ({ question: c.question, shouldRefuse: Boolean(c.expectRefusal) })),
    ...OUT_OF_CORPUS.map((question) => ({ question, shouldRefuse: true })),
  ];

  const rows: { shouldRefuse: boolean; dense: number; coverage: number; gated: boolean; question: string }[] = [];
  for (const probe of probes) {
    const result = await retrieve(repository, probe.question);
    rows.push({
      shouldRefuse: probe.shouldRefuse,
      dense: result.relevance.maxDenseScore,
      coverage: result.relevance.queryCoverage,
      gated: result.relevance.gated,
      question: probe.question,
    });
  }

  console.log(`${"want".padEnd(7)}${"got".padEnd(9)}${"dense".padEnd(9)}${"cover".padEnd(8)}question`);
  for (const row of rows.sort((a, b) => a.dense - b.dense)) {
    const want = row.shouldRefuse ? "refuse" : "answer";
    const got = row.gated ? "refused" : "answered";
    const mark = row.shouldRefuse === row.gated ? " " : "✗";
    console.log(
      `${mark}${want.padEnd(6)}${got.padEnd(9)}${row.dense.toFixed(4).padEnd(9)}${row.coverage.toFixed(3).padEnd(8)}${row.question}`,
    );
  }

  const answerable = rows.filter((row) => !row.shouldRefuse);
  const refusable = rows.filter((row) => row.shouldRefuse);
  console.log("\n─── separation ───");
  report("dense", answerable.map((r) => r.dense), refusable.map((r) => r.dense));
  report("coverage", answerable.map((r) => r.coverage), refusable.map((r) => r.coverage));
  console.log(`\nwrong decisions: ${rows.filter((row) => row.shouldRefuse !== row.gated).length}/${rows.length}`);
}

/**
 * A signal is only usable where the two populations do not overlap: the lowest
 * answerable value has to sit above the highest refusable one, or no threshold
 * exists that separates them.
 */
function report(name: string, answerable: number[], refusable: number[]) {
  const minAnswerable = Math.min(...answerable);
  const maxRefusable = Math.max(...refusable);
  const verdict =
    minAnswerable > maxRefusable
      ? `separable — any threshold in (${maxRefusable.toFixed(3)}, ${minAnswerable.toFixed(3)}]`
      : `OVERLAPS by ${(maxRefusable - minAnswerable).toFixed(3)} — cannot separate alone`;
  console.log(
    `${name.padEnd(9)} answerable min ${minAnswerable.toFixed(3)}  refusable max ${maxRefusable.toFixed(3)}  ${verdict}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
