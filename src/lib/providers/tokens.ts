/**
 * Token accounting.
 *
 * A real tokeniser (tiktoken) is a WASM blob and a build-time dependency for
 * something used here only to size windows and estimate cost. Characters/4 is
 * within ~10% on English prose, and every place it is used tolerates that: chunk
 * targets are soft, and the context budget has headroom. It is wrong for code
 * and for CJK text — noted in the README as a known limitation rather than
 * hidden.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

interface Price {
  /** USD per million tokens. */
  input: number;
  output: number;
}

/**
 * Static price table, deliberately conservative and clearly an estimate.
 * Unknown models fall back to zero rather than inventing a number.
 */
const PRICES: Record<string, Price> = {
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
  "text-embedding-3-small": { input: 0.02, output: 0 },
  "text-embedding-3-large": { input: 0.13, output: 0 },
};

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const price = PRICES[model];
  if (!price) return 0;
  return (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output;
}

export function knownPricing(model: string): boolean {
  return model in PRICES;
}
