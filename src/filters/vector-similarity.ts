import { logger } from '../logger.ts';
import { cosine } from '../providers/embeddings.ts';
import { skipped } from './base.ts';
import type { Filter, FilterContext } from './base.ts';
import type { FilterResult } from '../types.ts';

const NAME = 'VectorSimilarityMatcher';

/**
 * Semantic closeness between the generated CV and the job description, by
 * embedding cosine.
 *
 * The filter
 * that was silently dead there for months. Both of its bugs are fixed here and
 * guarded by tests:
 *
 *  1. It fails LOUDLY. An earlier design swallowed a hard 401 into `passed: true,
 *     score: 1.0`, so a permanently broken filter was indistinguishable from a
 *     perfect match. Here an embedding failure is `skipped()` with a WARN and
 *     an explicit NaN score, so it can never read as agreement.
 *  2. The score is RAW COSINE, not `(cos + 1) / 2`. That rescale compressed the
 *     usable range into [0.5, 1.0] and made the threshold unreachable - a
 *     sourdough recipe scored 0.72 against the CV and passed a 0.4 threshold.
 *
 * Coarse by nature: whole-document embedding averages away detail, so it
 * separates a software job from a bread recipe but barely distinguishes two
 * engineering roles. Treat it as an "is this even the right field" guard.
 */
export const vectorSimilarity: Filter = {
  name: NAME,
  priority: 6,

  evaluate: async ({ resume, job, config, embeddings }: FilterContext): Promise<FilterResult> => {
    const threshold = config.thresholds.vector;

    if (resume.pdfText === null) {
      return {
        filterName: NAME,
        passed: false,
        score: 0.0,
        threshold,
        issues: ['No PDF text available'],
        suggestions: ['Ensure PDF compilation succeeds'],
      };
    }

    if (Number.isNaN(threshold)) {
      // Deliberate: THRESHOLD_VECTOR has no default because the inherited 0.55
      // was calibrated against a different, hosted model. Refuse rather than
      // invent a bar. See docs/design-notes.md.
      logger.warn(
        `${NAME}: THRESHOLD_VECTOR is not set. It must be measured against the ` +
          `embedding model in use - a value measured elsewhere does not transfer.`,
      );
      return skipped(NAME, threshold, 'THRESHOLD_VECTOR has not been calibrated');
    }

    const jobText = `${job.title} ${job.description} ${job.requirements.join(' ')}`;

    let vectors: number[][];
    try {
      vectors = await embeddings.embed([resume.pdfText, jobText]);
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn(`${NAME}: embedding failed, filter skipped - this is NOT a verdict: ${reason}`);
      return skipped(NAME, threshold, `embedding failed: ${reason}`);
    }

    const [resumeVec, jobVec] = vectors;
    if (resumeVec === undefined || jobVec === undefined) {
      logger.warn(`${NAME}: expected 2 vectors, got ${vectors.length} - filter skipped`);
      return skipped(NAME, threshold, `expected 2 vectors, got ${vectors.length}`);
    }

    const score = cosine(resumeVec, jobVec);

    return {
      filterName: NAME,
      passed: score >= threshold,
      score,
      threshold,
      issues:
        score < threshold ? [`Low semantic similarity to job posting (${score.toFixed(2)})`] : [],
      suggestions: [],
    };
  },
};
