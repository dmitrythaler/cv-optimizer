import { vectorize } from '../text/tfidf.ts';
import type { Filter, FilterContext } from './base.ts';
import type { FilterResult, JobPosting } from '../types.ts';

const NAME = 'KeywordMatcher';

/** Escapes a term for use inside a RegExp, matching Python's `re.escape`. */
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface KeywordCheck {
  readonly score: number;
  readonly passed: boolean;
  readonly missingKeywords: readonly string[];
}

export interface KeywordOptions {
  readonly maxFeatures: number;
  readonly cutoff: number;
  readonly maxMissingDisplay: number;
}

/**
 * Port of `check_keywords()` in hr-breaker `filters/keyword_matcher.py`.
 *
 * The job text is vectorized, terms scoring above `cutoff` become the
 * "significant" set (plus any explicit `job.keywords`), and the score is the
 * share of that set's weight which appears in the CV.
 *
 * Deliberately weight-based, not count-based: missing a term the JD repeats
 * costs more than missing one it mentions once.
 */
export const checkKeywords = (
  resumeText: string,
  job: JobPosting,
  threshold: number,
  opts: KeywordOptions,
): KeywordCheck => {
  const resumeLower = resumeText.toLowerCase();
  const jobText = `${job.title} ${job.description} ${job.requirements.join(' ')}`;

  const scores = vectorize(jobText.toLowerCase(), { maxFeatures: opts.maxFeatures });

  // sklearn raises ValueError when a document yields no usable terms (e.g. it
  // is all stop words); the Python treats that as a pass.
  if (scores.size === 0) return { score: 1.0, passed: true, missingKeywords: [] };

  const significant = new Set<string>();
  for (const [term, score] of scores) if (score > opts.cutoff) significant.add(term);
  for (const kw of job.keywords) significant.add(kw.toLowerCase());

  if (significant.size === 0) return { score: 1.0, passed: true, missingKeywords: [] };

  const matched: string[] = [];
  const missing: string[] = [];
  for (const keyword of significant) {
    // \b around an escaped term, as the Python does.
    if (new RegExp(`\\b${escapeRe(keyword)}\\b`).test(resumeLower)) matched.push(keyword);
    else missing.push(keyword);
  }

  // 0.1 is the Python's fallback weight for an explicit job keyword that is not
  // in the vectorizer's vocabulary.
  const weight = (kw: string): number => scores.get(kw) ?? 0.1;
  const matchedWeight = matched.reduce((a, kw) => a + weight(kw), 0);
  const totalWeight = [...significant].reduce((a, kw) => a + weight(kw), 0);
  const score = totalWeight > 0 ? matchedWeight / totalWeight : 1.0;

  const missingSorted = [...missing]
    .sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0))
    .slice(0, opts.maxMissingDisplay);

  return { score, passed: score >= threshold, missingKeywords: missingSorted };
};

/**
 * TF-IDF term overlap between the generated CV and the job description.
 *
 * Ported from hr-breaker `filters/keyword_matcher.py`. Deterministic, free, and
 * historically the most trustworthy number in the set - it caught a genuine
 * domain mismatch (a computational-geometry role, 0.31) that both the embedding
 * filter and the vision model waved through.
 *
 * Grades `pdfText`, not the HTML: what an ATS extracts from the PDF is what
 * matters, and it differs from what the markup implies.
 */
export const keywordMatcher: Filter = {
  name: NAME,
  priority: 4,

  evaluate: ({ resume, job, config }: FilterContext): Promise<FilterResult> => {
    const threshold = config.thresholds.keyword;

    if (resume.pdfText === null) {
      return Promise.resolve({
        filterName: NAME,
        passed: false,
        score: 0.0,
        threshold,
        issues: ['No PDF text available'],
        suggestions: ['Ensure PDF compilation succeeds'],
      });
    }

    const result = checkKeywords(resume.pdfText, job, threshold, config.keyword);

    const issues: string[] = [];
    const suggestions: string[] = [];
    if (result.missingKeywords.length > 0 && !result.passed) {
      issues.push(`Missing important keywords: ${result.missingKeywords.join(', ')}`);
      suggestions.push('Add missing keywords if they match your actual experience');
    }

    return Promise.resolve({
      filterName: NAME,
      passed: result.passed,
      score: result.score,
      threshold,
      issues,
      suggestions,
    });
  },
};
