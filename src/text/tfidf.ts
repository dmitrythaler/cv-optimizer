import { SKLEARN_ENGLISH_STOP_WORDS } from './stopwords.ts';

/**
 * A reimplementation of exactly the scikit-learn vectorizer hr-breaker builds:
 *
 *   TfidfVectorizer(stop_words="english", ngram_range=(1, 2), max_features=N,
 *                   token_pattern=r"(?u)\b[a-zA-Z][a-zA-Z0-9+#.-]*\b")
 *
 * Two properties of that configuration make it reproducible without a linear
 * algebra library:
 *
 *  1. It is fitted on a SINGLE document. With smooth_idf (the default) and one
 *     document, idf = ln((1+n)/(1+df)) + 1 = ln(1) + 1 = 1 for every term. So
 *     tf-idf collapses to plain term frequency.
 *  2. norm="l2" (the default) then scales the count vector to unit length.
 *
 * So the score of a term is simply `count / sqrt(sum of all counts squared)`.
 * Verified against scikit-learn fixtures in test/tfidf.test.ts.
 */

/**
 * Port of `(?u)\b[a-zA-Z][a-zA-Z0-9+#.-]*\b`.
 *
 * Worth knowing what this does to real input:
 *  - "Node.js" survives whole, because "." is in the trailing character class.
 *  - "C++" yields "c". The trailing `\b` cannot sit between "+" and a space
 *    (neither is a word character), so the match backtracks to just "C".
 *    "C#" collapses the same way.
 *  - ".NET" yields "net" - the token must START with a letter.
 */
const TOKEN = /\b[a-zA-Z][a-zA-Z0-9+#.-]*\b/g;

export const tokenize = (text: string): string[] => text.match(TOKEN) ?? [];

/**
 * Unigrams + bigrams, matching sklearn's `_word_ngrams`.
 *
 * Stop words are dropped BEFORE bigrams are formed, so "the lazy dog with a
 * very good system" yields the bigram "lazy dog" and then "dog good" - it
 * bridges the gap left by the removed words rather than breaking there.
 */
export const ngrams = (tokens: readonly string[], stopWords: ReadonlySet<string>): string[] => {
  const kept = tokens.filter((t) => !stopWords.has(t));
  const out = [...kept];
  for (let i = 0; i + 1 < kept.length; i++) out.push(`${kept[i]} ${kept[i + 1]}`);
  return out;
};

export interface VectorizeOptions {
  readonly maxFeatures: number;
  readonly stopWords?: ReadonlySet<string>;
}

/**
 * Returns term -> L2-normalized tf-idf weight for a single document.
 *
 * Feature selection mirrors sklearn's `_limit_features`: keep the
 * `maxFeatures` most frequent terms. sklearn sorts the vocabulary
 * alphabetically before selecting, so ties are broken alphabetically here to
 * match. (numpy's argsort is not formally stable, so an exact tie ordering is
 * not guaranteed on either side - it only matters at the max_features cliff.)
 */
export const vectorize = (
  document: string,
  { maxFeatures, stopWords = SKLEARN_ENGLISH_STOP_WORDS }: VectorizeOptions,
): Map<string, number> => {
  const terms = ngrams(tokenize(document.toLowerCase()), stopWords);

  const counts = new Map<string, number>();
  for (const t of terms) counts.set(t, (counts.get(t) ?? 0) + 1);

  const selected = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxFeatures);

  const norm = Math.sqrt(selected.reduce((acc, [, c]) => acc + c * c, 0));
  const out = new Map<string, number>();
  if (norm === 0) return out;
  for (const [term, c] of selected) out.set(term, c / norm);
  return out;
};
