import type { Config } from '../config.ts';
import type { FilterResult, JobPosting, OptimizedResume, ResumeSource } from '../types.ts';

export interface FilterContext {
  readonly resume: OptimizedResume;
  readonly job: JobPosting;
  readonly source: ResumeSource;
  readonly config: Config;
}

/**
 * A filter grades one candidate CV.
 *
 * Contract notes, learned the hard way from the Python original:
 *  - `score` is diagnostic only. `passed` is what the pipeline acts on.
 *  - Never invent a passing score to paper over an internal error. If the
 *    filter cannot do its job, say so via `skipped` so the caller can decide.
 */
export interface Filter {
  readonly name: string;
  /** Lower runs first. Cheap deterministic checks before paid model calls. */
  readonly priority: number;
  evaluate(ctx: FilterContext): Promise<FilterResult>;
}

/** Convenience for filters that could not run at all (network, auth, missing input). */
export const skipped = (name: string, threshold: number, reason: string): FilterResult => ({
  filterName: name,
  passed: true,
  score: Number.NaN,
  threshold,
  issues: [`SKIPPED - filter could not run: ${reason}`],
  suggestions: [],
});
