import { config } from "@/lib/config";
import { extractCitations } from "@/lib/sources";
import type { GuardrailFlag, GuardrailVerdict, Source } from "@/lib/types";

/**
 * Guardrails.
 *
 * Three things are worth guarding in a system like this, and they are not the
 * things usually meant by "guardrails". There is no user-generated content to
 * moderate here and no reason to refuse topics: the corpus is the user's own
 * meetings. What actually goes wrong is:
 *
 * 1. Answering with no evidence. Handled before the model is called: if nothing
 *    was retrieved, refuse and skip the request entirely. Cheaper and far more
 *    reliable than hoping the model refuses on its own.
 *
 * 2. Citations that do not resolve. Models invent [S9] when eight sources were
 *    given. Invalid markers are stripped and counted, so the failure is visible
 *    rather than lending false authority.
 *
 * 3. Assertions with no citation at all. Measured as coverage rather than
 *    enforced, and surfaced in the UI as a warning. Rewriting or rejecting the
 *    answer would trade a slightly ungrounded answer for no answer, which users
 *    like less than a flagged one.
 *
 * Prompt injection from the corpus is a real concern — a transcript can contain
 * anything a participant said out loud. It is handled by framing, not filtering:
 * sources are delimited and declared to be data. Ingested content that looks
 * like instructions is flagged so it is at least visible.
 */

const INJECTION_PATTERNS = [
  /ignore (?:all |the )?(?:previous|above|prior) instructions/i,
  /disregard (?:all |the )?(?:previous|above|prior)/i,
  /you are now (?:a|an) /i,
  /system prompt/i,
  /reveal your (?:instructions|prompt)/i,
];

export function detectInjectionAttempts(text: string): string[] {
  return INJECTION_PATTERNS.filter((pattern) => pattern.test(text)).map((pattern) => pattern.source);
}

export interface InputCheck {
  ok: boolean;
  reason?: string;
  flags: GuardrailFlag[];
}

export function checkQuestion(question: string): InputCheck {
  const trimmed = question.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "The question is empty.", flags: [] };
  }
  if (trimmed.length > config.guardrails.maxQuestionChars) {
    return {
      ok: false,
      reason: `That question is ${trimmed.length} characters; the limit is ${config.guardrails.maxQuestionChars}. Please shorten it.`,
      flags: ["input-too-long"],
    };
  }
  return { ok: true, flags: [] };
}

/** Sentence split on boundaries followed by a capital, so decimals and abbreviations survive. */
export function splitIntoSentences(text: string): string[] {
  return text
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z"'(\p{Lu}])/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/**
 * A sentence needs a citation only if it asserts something about the meetings.
 * Framing ("Here is what I found"), refusals and questions back to the user do
 * not, and counting them would make coverage meaningless.
 */
const NON_ASSERTIVE = [
  /^(here|that|this) (is|are|was|were)\b/i,
  /^(i|we) (could not|couldn't|did not|didn't|cannot|can't|found no|don't)\b/i,
  /^(nothing|no source|none of)\b/i,
  /^(you (might|may|could)|try|consider|ask)\b/i,
  /^(based on|according to) the (retrieved|provided|indexed)/i,
  /^open the sources/i,
  /\?$/,
];

function isAssertive(sentence: string): boolean {
  if (sentence.split(/\s+/).length < 4) return false;
  return !NON_ASSERTIVE.some((pattern) => pattern.test(sentence.trim()));
}

export function evaluateAnswer(answer: string, sources: Source[]): GuardrailVerdict {
  const validLabels = new Set(sources.map((source) => source.label));
  const cited = extractCitations(answer);
  const invalidCitations = cited.filter((label) => !validLabels.has(label));

  const sentences = splitIntoSentences(answer).filter(isAssertive);
  const withCitation = sentences.filter((sentence) => extractCitations(sentence).some((label) => validLabels.has(label)));
  const citationCoverage = sentences.length === 0 ? 1 : withCitation.length / sentences.length;

  const flags: GuardrailFlag[] = [];
  if (sources.length === 0) flags.push("no-evidence");
  if (invalidCitations.length > 0) flags.push("invalid-citations");
  if (sources.length > 0 && citationCoverage < config.guardrails.minCitationCoverage) flags.push("low-citation-coverage");

  return { citationCoverage: Number(citationCoverage.toFixed(2)), invalidCitations, flags };
}

/** Removes citation markers that point at nothing, leaving the sentence readable. */
export function stripInvalidCitations(answer: string, sources: Source[]): string {
  const validLabels = new Set(sources.map((source) => source.label));
  return answer
    .replace(/\[(S\d+(?:\s*,\s*S\d+)*)\]/g, (match, group: string) => {
      const kept = group
        .split(/\s*,\s*/)
        .map((label) => label.trim())
        .filter((label) => validLabels.has(label));
      return kept.length > 0 ? `[${kept.join(", ")}]` : "";
    })
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.,;:])/g, "$1");
}

/** The refusal used when retrieval came back empty. Written once, so it stays consistent. */
export function noEvidenceAnswer(question: string, corpusEmpty: boolean): string {
  if (corpusEmpty) {
    return "There are no meetings indexed yet, so there is nothing for me to search. Upload a transcript, or load the sample corpus from the sidebar, and ask again.";
  }
  return `I could not find anything in the indexed meetings that speaks to "${question.trim()}". Nothing scored above the relevance floor, so rather than guess: try naming a person, a project or a decision that would have come up, or widen the meeting selection in the sidebar.`;
}
