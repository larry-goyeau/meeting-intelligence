import { parseSourceBlock } from "@/lib/sources";
import { tokenizeWords } from "@/lib/text";
import type {
  ChatProvider,
  ChatRequest,
  ChatResult,
  ChatStreamEvent,
  EmbeddingProvider,
  EmbeddingResult,
  TranscriptionProvider,
} from "./types";
import { estimateTokens } from "./tokens";

/**
 * Offline provider: no network, no API key, fully deterministic.
 *
 * This exists for three concrete reasons, in order of importance:
 *
 * 1. The test suite and the evaluation harness must be deterministic and free.
 *    Asserting on retrieval behaviour is impossible if the embeddings change
 *    under you and every assertion costs money.
 * 2. A reviewer can clone the repo, run one command and get a working app
 *    without hunting for credentials.
 * 3. It forces the vendor boundary to stay honest. Anything that leaks OpenAI
 *    specifics upward breaks this provider immediately.
 *
 * It is emphatically not "an LLM". Embeddings are a hashing trick over word
 * n-grams, so similarity is lexical, not semantic — it will miss paraphrases.
 * Answers are extractive: the best-matching sentences from the retrieved
 * sources, cited. The UI labels this mode explicitly so nobody mistakes it for
 * the real thing.
 */

const DIMENSIONS = 512;

/** FNV-1a, 32-bit. Cheap, well-distributed enough for a hashing trick. */
function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
}

/**
 * Hashed bag of unigrams and bigrams with sublinear term frequency, L2
 * normalised so cosine similarity is a dot product. Bigrams matter here:
 * "postpone migration" should not look like "postpone standup".
 */
export function hashEmbed(text: string, dimensions = DIMENSIONS): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const words = tokenizeWords(text);
  const counts = new Map<string, number>();
  const bump = (term: string) => counts.set(term, (counts.get(term) ?? 0) + 1);
  for (let i = 0; i < words.length; i += 1) {
    bump(words[i] ?? "");
    if (i + 1 < words.length) bump(`${words[i]} ${words[i + 1]}`);
  }
  for (const [term, count] of counts) {
    const index = hash(term) % dimensions;
    // Sign from a second hash keeps unrelated collisions from always reinforcing.
    const sign = hash(`${term}#`) % 2 === 0 ? 1 : -1;
    vector[index] = (vector[index] ?? 0) + sign * (1 + Math.log(count));
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) return vector;
  return vector.map((value) => value / norm);
}

export const offlineEmbeddings: EmbeddingProvider = {
  id: "offline-hash",
  model: "hashed-ngrams-512",
  dimensions: DIMENSIONS,
  async embed(texts: string[]): Promise<EmbeddingResult> {
    return {
      vectors: texts.map((text) => hashEmbed(text)),
      tokens: texts.reduce((sum, text) => sum + estimateTokens(text), 0),
    };
  },
};

/** "S2, S10" rather than "S10, S2": labels are numbered, so sort numerically. */
function sortLabels(labels: string[]): string[] {
  return [...labels].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

function lastUserMessage(request: ChatRequest): string {
  for (let i = request.messages.length - 1; i >= 0; i -= 1) {
    const message = request.messages[i];
    if (message?.role === "user") return message.content;
  }
  return "";
}

/** The question is on the last line of the answer prompt, after the sources block. */
function questionFromPrompt(prompt: string): string {
  const afterSources = prompt.split("</sources>").at(-1) ?? prompt;
  const match = /Question:\s*([\s\S]+)$/.exec(afterSources);
  return (match?.[1] ?? afterSources).trim();
}

function extractiveAnswer(prompt: string): string {
  const sources = parseSourceBlock(prompt);
  if (sources.length === 0) {
    return "I could not find anything in the indexed meetings that speaks to that.";
  }
  const question = questionFromPrompt(prompt);
  const queryTerms = new Set(tokenizeWords(question));

  const scored = sources.flatMap((source) =>
    splitSentences(source.text).map((sentence) => {
      const terms = tokenizeWords(sentence);
      const overlap = terms.filter((term) => queryTerms.has(term)).length;
      // Normalise by length so a long rambling turn does not win on volume alone.
      return { label: source.label, meta: source.meta, sentence, score: overlap / Math.sqrt(terms.length + 1) };
    }),
  );

  // Chunks overlap by design, so the same turn legitimately arrives under two
  // labels. Collapse them into one line citing both rather than repeating it.
  const merged = new Map<string, { label: string; labels: string[]; sentence: string; score: number }>();
  for (const item of scored) {
    if (item.score <= 0) continue;
    const key = item.sentence.replace(/^\[[^\]]+\]\s*/, "").trim();
    const existing = merged.get(key);
    if (existing) {
      if (!existing.labels.includes(item.label)) existing.labels.push(item.label);
      existing.score = Math.max(existing.score, item.score);
    } else {
      merged.set(key, { label: item.label, labels: [item.label], sentence: item.sentence, score: item.score });
    }
  }

  const best = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, 4);

  if (best.length === 0) {
    const first = sources[0];
    const excerpt = splitSentences(first?.text ?? "")[0] ?? first?.text ?? "";
    return [
      "Offline mode found no sentence matching those words, so here is the closest retrieved excerpt instead.",
      "",
      `${excerpt} [${first?.label ?? "S1"}]`.trim(),
    ].join("\n");
  }

  const lines = best.map(
    (item) => `- ${item.sentence.replace(/^\[[^\]]+\]\s*/, "")} [${sortLabels(item.labels).join(", ")}]`,
  );
  return [
    "Based on the retrieved excerpts (offline extractive mode \u2014 no language model was used):",
    "",
    ...lines,
    "",
    "Open the sources panel to read the surrounding turns in context.",
  ].join("\n");
}

/**
 * Stands in for history-aware query rewriting. It cannot resolve reference the
 * way a model does; it appends the content words of the previous question when
 * the new one leans on a pronoun, which covers the common "and who owned it?"
 * follow-up.
 */
function rewriteQuery(request: ChatRequest): string {
  const prompt = lastUserMessage(request);
  const historyMatch = /<history>([\s\S]*?)<\/history>/.exec(prompt);
  const questionMatch = /<question>([\s\S]*?)<\/question>/.exec(prompt);
  const question = (questionMatch?.[1] ?? prompt).trim();
  const history = (historyMatch?.[1] ?? "").trim();
  const leansOnContext = /\b(it|that|this|they|them|those|he|she|there|the same|instead)\b/i.test(question) || tokenizeWords(question).length <= 3;
  if (!leansOnContext || history.length === 0) return question;
  const priorTerms = [...new Set(tokenizeWords(history))].slice(-8);
  return priorTerms.length > 0 ? `${question} (${priorTerms.join(" ")})` : question;
}

const DECISION_CUES = [
  "we decided",
  "we've decided",
  "we have decided",
  "let's go with",
  "we'll go with",
  "we will go with",
  "decision is",
  "agreed to",
  "we agree",
  "we're going with",
  "final call",
  "sign off on",
  "approved",
  "consensus is",
];

const REVERSAL_CUES = [
  "change of plan",
  "reversing",
  "we're not going to",
  "we are not going to",
  "scrap that",
  "no longer",
  "instead of what we said",
  "overturn",
  "revisit that decision",
  "backing out",
  "reverse the",
];

const ACTION_CUES = ["i'll", "i will", "can you", "please", "action item", "take that", "owns", "by end of", "by next", "follow up", "will send", "will draft"];

const QUESTION_CUES = ["open question", "not sure", "unclear", "we need to figure out", "still don't know", "tbd", "to be decided"];

interface OfflineBrief {
  summary: string;
  topics: string[];
  decisions: { decision: string; rationale: string | null; owner: string | null; status: string; atMs: number | null }[];
  actionItems: { task: string; owner: string | null; due: string | null; atMs: number | null }[];
  openQuestions: string[];
}

const LINE_PREFIX = /^\[(\d{1,3}:[0-5]\d(?::[0-5]\d)?)\]\s*([^:]{1,60}?):\s*(.*)$/;

function briefFromTranscript(prompt: string): OfflineBrief {
  const lines = prompt.split("\n");
  const decisions: OfflineBrief["decisions"] = [];
  const actionItems: OfflineBrief["actionItems"] = [];
  const openQuestions: string[] = [];
  const termCounts = new Map<string, number>();

  for (const line of lines) {
    const match = LINE_PREFIX.exec(line.trim());
    const speaker = match?.[2] ?? null;
    const body = match?.[3] ?? line.trim();
    const atMs = match?.[1] ? clockToMs(match[1]) : null;

    for (const term of tokenizeWords(body)) termCounts.set(term, (termCounts.get(term) ?? 0) + 1);

    for (const sentence of splitSentences(body)) {
      const sentenceLower = sentence.toLowerCase();
      if (DECISION_CUES.some((cue) => sentenceLower.includes(cue))) {
        const reversed = REVERSAL_CUES.some((cue) => sentenceLower.includes(cue));
        decisions.push({ decision: sentence, rationale: null, owner: speaker, status: reversed ? "reversed" : "agreed", atMs });
      } else if (REVERSAL_CUES.some((cue) => sentenceLower.includes(cue))) {
        decisions.push({ decision: sentence, rationale: null, owner: speaker, status: "reversed", atMs });
      }
      if (ACTION_CUES.some((cue) => sentenceLower.includes(cue))) {
        const due = /\bby (the )?(end of |next )?[\w\s]{2,20}\b/.exec(sentenceLower)?.[0] ?? null;
        actionItems.push({ task: sentence, owner: speaker, due, atMs });
      }
      if (QUESTION_CUES.some((cue) => sentenceLower.includes(cue)) || (sentence.endsWith("?") && sentence.split(/\s+/).length > 6)) {
        openQuestions.push(sentence);
      }
    }
  }

  const topics = [...termCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([term]) => term);

  const speakers = [...new Set(lines.map((line) => LINE_PREFIX.exec(line.trim())?.[2]).filter(Boolean))];
  const summary =
    `Offline heuristic pass over ${lines.length} transcript lines from ${speakers.length} speaker(s). ` +
    `Recurring terms: ${topics.slice(0, 5).join(", ")}. ` +
    `Cue phrases matched ${decisions.length} decision-like and ${actionItems.length} commitment-like statement(s). ` +
    `This is keyword matching, not comprehension \u2014 set OPENAI_API_KEY for a real summary.`;

  return {
    summary,
    topics,
    decisions: decisions.slice(0, 12),
    actionItems: dedupeBy(actionItems, (item) => item.task).slice(0, 12),
    openQuestions: [...new Set(openQuestions)].slice(0, 8),
  };
}

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function clockToMs(clock: string): number | null {
  const parts = clock.split(":").map(Number);
  if (parts.length === 2) return (parts[0] ?? 0) * 60_000 + (parts[1] ?? 0) * 1000;
  if (parts.length === 3) return (parts[0] ?? 0) * 3_600_000 + (parts[1] ?? 0) * 60_000 + (parts[2] ?? 0) * 1000;
  return null;
}

function respond(request: ChatRequest): string {
  const prompt = lastUserMessage(request);
  switch (request.task) {
    case "answer":
      return extractiveAnswer(prompt);
    case "rewrite":
      return rewriteQuery(request);
    case "brief-map":
      return JSON.stringify(briefFromTranscript(prompt));
    case "brief-reduce":
      return mergeBriefs(prompt);
  }
}

/** Reduce step: merges the JSON produced by each map call over a long meeting. */
function mergeBriefs(prompt: string): string {
  const parts = [...prompt.matchAll(/\{[\s\S]*?\}(?=\s*(?:\{|$))/g)].map((match) => match[0]);
  const merged: OfflineBrief = { summary: "", topics: [], decisions: [], actionItems: [], openQuestions: [] };
  const summaries: string[] = [];
  for (const part of parts) {
    try {
      const parsed = JSON.parse(part) as Partial<OfflineBrief>;
      if (parsed.summary) summaries.push(parsed.summary);
      merged.topics.push(...(parsed.topics ?? []));
      merged.decisions.push(...(parsed.decisions ?? []));
      merged.actionItems.push(...(parsed.actionItems ?? []));
      merged.openQuestions.push(...(parsed.openQuestions ?? []));
    } catch {
      // A malformed fragment is skipped rather than failing the whole brief.
    }
  }
  merged.summary = summaries.join(" ") || "No content extracted.";
  merged.topics = [...new Set(merged.topics)].slice(0, 10);
  merged.decisions = dedupeBy(merged.decisions, (d) => d.decision).slice(0, 15);
  merged.actionItems = dedupeBy(merged.actionItems, (a) => a.task).slice(0, 15);
  merged.openQuestions = [...new Set(merged.openQuestions)].slice(0, 10);
  return JSON.stringify(merged);
}

export const offlineChat: ChatProvider = {
  id: "offline-extractive",
  model: "deterministic-extractive",
  async complete(request: ChatRequest): Promise<ChatResult> {
    const text = respond(request);
    return {
      text,
      promptTokens: request.messages.reduce((sum, message) => sum + estimateTokens(message.content), 0),
      completionTokens: estimateTokens(text),
    };
  },
  async *stream(request: ChatRequest): AsyncGenerator<ChatStreamEvent> {
    const text = respond(request);
    // Chunked so the UI streaming path is exercised in offline mode too.
    const pieces = text.match(/\S+\s*/g) ?? [text];
    for (const piece of pieces) {
      yield { type: "delta", text: piece };
      await new Promise((resolve) => setTimeout(resolve, 6));
    }
    yield {
      type: "done",
      promptTokens: request.messages.reduce((sum, message) => sum + estimateTokens(message.content), 0),
      completionTokens: estimateTokens(text),
    };
  },
};

export const offlineTranscription: TranscriptionProvider = {
  id: "offline-none",
  model: "unavailable",
  available: false,
  async transcribe(): Promise<string> {
    throw new Error("Audio transcription needs a real provider. Set OPENAI_API_KEY to enable it.");
  },
};
