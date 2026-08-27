/**
 * Shared lexical helpers. Used by the offline embeddings, by the full-text query
 * builder and by the relevance gate, so all three agree on what counts as a
 * content word.
 */

/**
 * Includes the usual English function words plus the fillers that saturate spoken
 * transcripts. "yeah", "okay", "actually" and "sure" appear in almost every chunk
 * of every meeting, so they carry no retrieval signal and actively hurt: a query
 * matching only on those words looks like a hit when it is noise.
 */
export const STOPWORDS = new Set(
  (
    "a about above after again against all am an and any are aren as at be because been before being below between both but by " +
    "can cannot could couldn did didn do does doesn doing don down during each few for from further had hadn has hasn have haven " +
    "having he her here hers herself him himself his how i if in into is isn it its itself just me more most much my myself no nor " +
    "not of off on once only or other ought our ours ourselves out over own same shan she should shouldn so some such than that " +
    "the their theirs them themselves then there these they this those through to too under until up very was wasn we were weren " +
    "what when where which while who whom why will with won would wouldn you your yours yourself yourselves " +
    "yeah yep okay ok um uh like really think thing things going got know right sure well actually basically maybe kind sort " +
    "gonna wanna let lets us also even still back around one two three"
  ).split(" "),
);

export function tokenizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1 && !STOPWORDS.has(word));
}

/** Distinct content terms of a query, in first-seen order. */
export function contentTerms(text: string, limit = 24): string[] {
  return [...new Set(tokenizeWords(text).filter((word) => word.length > 2))].slice(0, limit);
}

/**
 * Specificity-weighted share of the query's terms that the retrieved text
 * actually contains.
 *
 * This is the relevance signal that does not depend on the embedding model, and
 * it exists to make "I don't know" reachable. A rare term carries more weight
 * than a common one, and a term that appears nowhere in the corpus carries the
 * most weight of all while being impossible to match — so a question made of
 * words the corpus has never heard scores near zero, which is exactly the
 * conclusion we want. A question phrased in the corpus's own vocabulary scores
 * high even when the wording differs.
 */
export function weightedCoverage(
  terms: string[],
  retrievedText: string,
  documentFrequencies: Map<string, number>,
  corpusSize: number,
): number {
  if (terms.length === 0) return 1;
  const haystack = retrievedText.toLowerCase();
  let matched = 0;
  let total = 0;
  for (const term of terms) {
    const df = documentFrequencies.get(term) ?? 0;
    const weight = Math.log(1 + corpusSize / (1 + df));
    total += weight;
    if (haystack.includes(term)) matched += weight;
  }
  return total === 0 ? 1 : matched / total;
}
