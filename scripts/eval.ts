/**
 * Evaluation harness.
 *
 * "Quality" for a system like this is not one number, and I did not want a score
 * that looks authoritative while measuring nothing. So this measures the two
 * things that can be measured honestly against a hand-written answer key:
 *
 *   Retrieval recall — for each question, did the evidence that *must* be present
 *   to answer it actually reach the prompt? This is the metric that matters,
 *   because no prompt engineering recovers from evidence that was never
 *   retrieved. It is also model-independent, so it is meaningful in offline mode.
 *
 *   Refusal correctness — on questions the corpus cannot answer, did the system
 *   decline? Silent invention is the failure mode that destroys trust fastest.
 *
 * When a real provider is configured it additionally generates answers and checks
 * citation validity, citation coverage, keyword presence, latency and cost.
 * Keyword presence is a weak proxy and is reported as such, not as accuracy. A
 * fuller setup would add pairwise LLM-as-judge grading against reference answers;
 * that is in the README's "what I would do next" rather than half-built here.
 *
 * Usage: npm run eval [-- --answers] [-- --case=<id>]
 */
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../src/lib/config";
import { providerSummary } from "../src/lib/providers";
import { ask } from "../src/lib/rag/answer";
import { ingestTranscript } from "../src/lib/rag/ingest";
import { retrieve } from "../src/lib/rag/retrieve";
import { createMemoryDb } from "../src/lib/store/db";
import { Repository } from "../src/lib/store/repository";
import { extractCitations } from "../src/lib/sources";

interface Case {
  id: string;
  question: string;
  mustRetrieve: string[];
  shouldMention: string[];
  expectRefusal?: boolean;
  note?: string;
}

interface Outcome {
  id: string;
  question: string;
  recall: number;
  missing: string[];
  refused: boolean;
  refusalCorrect: boolean;
  sources: number;
  retrievalMs: number;
  answer?: string;
  mentioned?: string[];
  missingMentions?: string[];
  citationCoverage?: number;
  invalidCitations?: number;
  totalMs?: number;
  costUsd?: number;
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ");
}

async function main() {
  const args = process.argv.slice(2);
  const withAnswers = args.includes("--answers");
  const only = args.find((arg) => arg.startsWith("--case="))?.split("=")[1];

  const provider = providerSummary();
  console.log("Meeting Intelligence — evaluation");
  console.log(`  provider   ${provider.id}${provider.remote ? "" : " (offline: hashed embeddings, extractive answers)"}`);
  console.log(`  embeddings ${provider.embeddingModel} (${provider.embeddingDimensions}d)`);
  console.log(`  retrieval  dense k=${config.retrieval.denseK}, lexical k=${config.retrieval.lexicalK}, final k=${config.retrieval.finalK}, mmr λ=${config.retrieval.mmrLambda}, neighbours ±${config.retrieval.neighborRadius}`);
  console.log(`  chunking   ${config.chunking.targetTokens} tok target, ${config.chunking.overlapTokens} tok overlap\n`);

  // A throwaway in-memory index, so an evaluation run never touches the dev corpus.
  const repository = new Repository(createMemoryDb());
  const filenames = (await fs.readdir(config.sampleDir)).filter((name) => /\.(txt|md|vtt|srt)$/i.test(name)).sort();
  process.stdout.write("Indexing sample corpus… ");
  for (const filename of filenames) {
    const content = await fs.readFile(path.join(config.sampleDir, filename), "utf8");
    await ingestTranscript({ filename, content, source: "sample" }, repository);
  }
  console.log(`${repository.listMeetings().length} meetings, ${repository.countChunks()} chunks\n`);

  const raw = JSON.parse(await fs.readFile(path.join(process.cwd(), "data/eval/golden.json"), "utf8")) as { cases: Case[] };
  const cases = only ? raw.cases.filter((testCase) => testCase.id === only) : raw.cases;
  if (cases.length === 0) {
    console.error(only ? `No case with id "${only}".` : "The golden set is empty.");
    process.exit(1);
  }

  const outcomes: Outcome[] = [];

  for (const testCase of cases) {
    const started = Date.now();
    const retrieval = await retrieve(repository, testCase.question);
    const retrievalMs = Date.now() - started;
    const haystack = normalise(retrieval.sources.map((source) => source.text).join("\n"));
    const missing = testCase.mustRetrieve.filter((needle) => !haystack.includes(normalise(needle)));
    const recall = testCase.mustRetrieve.length === 0 ? 1 : (testCase.mustRetrieve.length - missing.length) / testCase.mustRetrieve.length;
    const refused = retrieval.sources.length === 0;

    const outcome: Outcome = {
      id: testCase.id,
      question: testCase.question,
      recall,
      missing,
      refused,
      refusalCorrect: Boolean(testCase.expectRefusal) === refused,
      sources: retrieval.sources.length,
      retrievalMs,
    };

    if (withAnswers) {
      const answerStarted = Date.now();
      let answer = "";
      let labels = new Set<string>();
      let coverage: number | undefined;
      let invalid = 0;
      let costUsd = 0;
      for await (const event of ask({ question: testCase.question, history: [], meetingIds: [] }, repository)) {
        if (event.type === "meta") labels = new Set((event.data as { sources: { label: string }[] }).sources.map((s) => s.label));
        if (event.type === "delta") answer += event.data as string;
        if (event.type === "done") {
          const done = event.data as { verdict: { citationCoverage: number; invalidCitations: string[] }; usage: { estimatedCostUsd: number }; answer?: string };
          coverage = done.verdict.citationCoverage;
          invalid = done.verdict.invalidCitations.length;
          costUsd = done.usage.estimatedCostUsd;
          if (done.answer) answer = done.answer;
        }
      }
      const lowerAnswer = normalise(answer);
      outcome.answer = answer;
      outcome.mentioned = testCase.shouldMention.filter((needle) => lowerAnswer.includes(normalise(needle)));
      outcome.missingMentions = testCase.shouldMention.filter((needle) => !lowerAnswer.includes(normalise(needle)));
      outcome.citationCoverage = coverage;
      outcome.invalidCitations = invalid + extractCitations(answer).filter((label) => !labels.has(label)).length;
      outcome.totalMs = Date.now() - answerStarted;
      outcome.costUsd = costUsd;
    }

    outcomes.push(outcome);
    report(outcome, testCase);
  }

  summarise(outcomes, withAnswers, provider.remote);

  const outputDir = path.join(process.cwd(), "eval-results");
  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await fs.writeFile(outputPath, JSON.stringify({ provider, config: { retrieval: config.retrieval, chunking: config.chunking }, outcomes }, null, 2));
  console.log(`\nFull results written to ${path.relative(process.cwd(), outputPath)}`);

  // Non-zero exit on regression, so this can gate a pipeline.
  //
  // Refusal correctness is only enforced when a real embedding model is
  // configured. The relevance gate combines two signals — an absolute cosine
  // floor and lexical query coverage — and in offline mode the first one carries
  // no information: hashed n-gram vectors score an unrelated question at 0.15 and
  // a relevant one at 0.20, so no threshold separates them. Coverage alone then
  // has to carry the decision, and it cannot: "what is the parental leave policy"
  // shares "policy", "leave" and "company" with a corpus that discusses retention
  // policies and leaving meetings. Failing CI over a limitation of the offline
  // stand-in would only teach us to lower the bar, so it is reported and not
  // enforced. See the README's offline-mode limitations.
  const recallFloor = 0.8;
  const meanRecall = average(outcomes.map((outcome) => outcome.recall));
  const refusalOk = outcomes.every((outcome) => outcome.refusalCorrect);
  const failures: string[] = [];
  if (meanRecall < recallFloor) failures.push(`mean retrieval recall ${meanRecall.toFixed(2)} is below the ${recallFloor} floor`);
  if (provider.remote && !refusalOk) failures.push("at least one refusal decision was wrong");

  if (failures.length > 0) {
    console.error(`\nFAIL: ${failures.join("; ")}`);
    process.exit(1);
  }
  console.log("\nPASS");
}

function report(outcome: Outcome, testCase: Case) {
  const mark = outcome.recall === 1 && outcome.refusalCorrect ? "✓" : outcome.recall > 0 && outcome.refusalCorrect ? "~" : "✗";
  console.log(`${mark} ${outcome.id}`);
  console.log(`    ${outcome.question}`);
  console.log(
    `    recall ${(outcome.recall * 100).toFixed(0)}%  sources ${outcome.sources}  retrieval ${outcome.retrievalMs} ms${
      testCase.expectRefusal ? `  expected refusal: ${outcome.refused ? "yes" : "NO"}` : ""
    }`,
  );
  if (outcome.missing.length > 0) console.log(`    missing evidence: ${outcome.missing.map((needle) => `"${needle}"`).join(", ")}`);
  if (outcome.answer !== undefined) {
    console.log(
      `    coverage ${Math.round((outcome.citationCoverage ?? 0) * 100)}%  invalid citations ${outcome.invalidCitations}  ${outcome.totalMs} ms  $${(outcome.costUsd ?? 0).toFixed(5)}`,
    );
    if ((outcome.missingMentions ?? []).length > 0) console.log(`    absent keywords: ${outcome.missingMentions?.join(", ")}`);
    console.log(`    ${outcome.answer.replace(/\n/g, " ").slice(0, 200)}…`);
  }
  console.log();
}

function summarise(outcomes: Outcome[], withAnswers: boolean, isRemote: boolean) {
  const perfect = outcomes.filter((outcome) => outcome.recall === 1).length;
  console.log("─".repeat(72));
  console.log(`cases                 ${outcomes.length}`);
  console.log(`mean retrieval recall ${(average(outcomes.map((o) => o.recall)) * 100).toFixed(1)}%`);
  console.log(`full recall           ${perfect}/${outcomes.length}`);
  console.log(
    `refusal correctness   ${outcomes.filter((o) => o.refusalCorrect).length}/${outcomes.length}${isRemote ? "" : "  (reported only: offline embeddings cannot judge relevance)"}`,
  );
  console.log(`median retrieval      ${median(outcomes.map((o) => o.retrievalMs))} ms`);
  if (withAnswers) {
    const covered = outcomes.map((o) => o.citationCoverage ?? 0);
    console.log(`mean citation coverage ${(average(covered) * 100).toFixed(1)}%`);
    console.log(`invalid citations     ${outcomes.reduce((sum, o) => sum + (o.invalidCitations ?? 0), 0)}`);
    console.log(`keyword presence      ${(average(outcomes.map((o) => proportion(o))) * 100).toFixed(1)}%  (weak proxy, not accuracy)`);
    console.log(`median end-to-end     ${median(outcomes.map((o) => o.totalMs ?? 0))} ms`);
    console.log(`total estimated cost  $${outcomes.reduce((sum, o) => sum + (o.costUsd ?? 0), 0).toFixed(4)}`);
  } else {
    console.log("\nRun with `npm run eval -- --answers` to also generate and grade answers.");
  }
}

function proportion(outcome: Outcome): number {
  const total = (outcome.mentioned?.length ?? 0) + (outcome.missingMentions?.length ?? 0);
  return total === 0 ? 1 : (outcome.mentioned?.length ?? 0) / total;
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
