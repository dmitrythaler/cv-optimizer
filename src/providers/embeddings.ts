/**
 * Embedding access.
 *
 * Local only. The model runs in-process (in a worker thread), so there is no
 * API key, no rate limit and no auth-failure path - which is what killed the
 * Python version's vector filter for two months.
 *
 * Kept separate from ChatProvider because they are unrelated concerns: chat is
 * a remote API call, embedding is local inference.
 */

export interface EmbeddingProvider {
  readonly model: string;
  /** Vector length actually produced. Known only after the model loads. */
  dimensions(): Promise<number>;
  embed(texts: readonly string[]): Promise<number[][]>;
  close(): Promise<void>;
}

/** Cosine similarity. Raw, unrescaled - see docs/porting-notes.md for why that matters. */
export const cosine = (a: readonly number[], b: readonly number[]): number => {
  if (a.length !== b.length) {
    throw new Error(`vector length mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
};
