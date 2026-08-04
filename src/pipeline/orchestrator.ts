import type { Config } from '../config.ts';
import type { JobPosting, OptimizationOutcome, OptimizedResume, ResumeSource } from '../types.ts';

export interface Generator {
  /** Produce a candidate CV. `feedback` carries the previous round's complaints. */
  generate(
    source: ResumeSource,
    job: JobPosting,
    feedback: readonly string[],
  ): Promise<OptimizedResume>;
}

/**
 * The generate/grade loop.
 *
 * Not implemented. Shape: generate -> render -> grade -> pass? file it : feed
 * failures back, up to `config.maxIterations`.
 *
 * Callers must check `outcome.passed` - a PDF is produced either way.
 */
export const optimize = (
  _source: ResumeSource,
  _job: JobPosting,
  _generator: Generator,
  _config: Config,
): Promise<OptimizationOutcome> => {
  throw new Error('optimize() not implemented');
};
