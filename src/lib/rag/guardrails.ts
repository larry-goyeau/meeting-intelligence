import { config } from "@/lib/config";
import { CITATION_PATTERN, extractCitations, parseCitationToken } from "@/lib/sources";
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

/**
 * The model declining because the evidence does not cover the question.
 *
 * This matters because the model turns out to be the *better* judge of
 * answerability than the retrieval gate. Calibrating the gate against real
 * embeddings (`npm run gate`) showed neither of its signals separates answerable
 * from unanswerable questions: a question shaped like the corpus scores 0.40
 * cosine on a topic the corpus never mentions, higher than genuinely answerable
 * questions. The model reads the excerpts and gets it right anyway — so the
 * remaining job is to notice when it has declined, rather than filing a correct
 * refusal as an answer that forgot to cite its sources.
 */
const DECLINE_PATTERNS = [
  /\b(do|does|did) not (contain|include|mention|provide|cover|say|specify|discuss)\b/i,
  /\b(no|not any) (information|mention|record|reference|discussion|detail)s? (about|on|regarding|of)\b/i,
  /\bis not (mentioned|discussed|covered|addressed|stated|specified)\b/i,
  /\b(cannot|can't|could not|couldn't) (find|answer|determine|tell)\b/i,
  /\bnothing (in|about) the (excerpts|sources|transcripts?|meetings?)\b/i,
  /\bI (could not|couldn't|did not|didn't) find\b/i,
];

export function looksLikeDecline(answer: string): boolean {
  /**
   * Only the first sentence counts. A real decline leads with it — the prompt
   * requires answering the question first — whereas "the excerpts do not say who
   * signed it off" in a later sentence is a caveat on a substantive answer. Reading
   * further conflated the two. Under-detecting is the safe direction: a missed
   * decline is reported as low citation coverage, while a false one would claim the
   * system refused when it actually answered.
   */
  const opening = splitIntoSentences(answer)[0] ?? "";
  return DECLINE_PATTERNS.some((pattern) => pattern.test(opening));
}

export function evaluateAnswer(answer: string, sources: Source[]): GuardrailVerdict {
  const validLabels = new Set(sources.map((source) => source.label));
  const cited = extractCitations(answer);
  const invalidCitations = cited.filter((label) => !validLabels.has(label));

  const sentences = splitIntoSentences(answer).filter(isAssertive);
  const withCitation = sentences.filter((sentence) => extractCitations(sentence).some((label) => validLabels.has(label)));
  const citationCoverage = sentences.length === 0 ? 1 : withCitation.length / sentences.length;
  const declined = looksLikeDecline(answer);

  const flags: GuardrailFlag[] = [];
  if (sources.length === 0) flags.push("no-evidence");
  if (declined) flags.push("declined");
  if (invalidCitations.length > 0) flags.push("invalid-citations");
  // A decline has nothing to cite, so low coverage is the correct shape for it and
  // warning the user to "verify this" would be noise.
  if (sources.length > 0 && !declined && citationCoverage < config.guardrails.minCitationCoverage) {
    flags.push("low-citation-coverage");
  }

  return { citationCoverage: Number(citationCoverage.toFixed(2)), invalidCitations, flags, declined };
}

/**
 * Removes citation markers that point at nothing, leaving the sentence readable.
 * Timecodes inside a marker are kept: they are the reader's way back to the moment,
 * and dropping them would lose information the model got right.
 */
export function stripInvalidCitations(answer: string, sources: Source[]): string {
  const validLabels = new Set(sources.map((source) => source.label));
  return answer
    .replace(CITATION_PATTERN, (token) => {
      // Walk in order so a span attached to a dropped label goes with it, rather
      // than being re-attached to whichever source happens to survive.
      const kept: string[] = [];
      let lastLabelValid = false;
      for (const item of parseCitationToken(token).items) {
        if (item.kind === "label") {
          lastLabelValid = validLabels.has(item.value);
          if (lastLabelValid) kept.push(item.value);
        } else if (lastLabelValid || kept.length === 0) {
          kept.push(item.value);
        }
      }
      const hasLabel = kept.some((part) => /^S\d+$/.test(part));
      return hasLabel ? `[${kept.join(", ")}]` : "";
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
