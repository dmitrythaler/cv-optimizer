import type { Config } from '../config.ts';
import type { EmbeddingProvider } from '../providers/embeddings.ts';
import type { ChatProviders } from '../providers/ai-sdk.ts';
import type { FilterResult, JobPosting, OptimizedResume, ResumeSource } from '../types.ts';

export interface FilterContext {
  readonly resume: OptimizedResume;
  readonly job: JobPosting;
  readonly source: ResumeSource;
  readonly config: Config;
  /**
   * Model access, supplied by the pipeline. Filters receive their dependencies
   * rather than constructing them - a filter that could build its own provider
   * could also silently mask a misconfigured one, which is how hr-breaker
   * shipped a dead filter for two months.
   *
   * Three models, split by cost, as hr-breaker splits them. Each filter picks
   * the one it needs. Only `vision` must accept images.
   */
  readonly chat: ChatProviders;
  /** Local embedding access, supplied by the pipeline. Same rule as `chat`. */
  readonly embeddings: EmbeddingProvider;
  /**
   * Resolved language the optimized CV was written in, e.g. "en", "pl".
   * Distinct from `job.language`: the target can be overridden, and filters
   * that compare wording need to know which language they are looking at.
   * hr-breaker threads this through `evaluate()` the same way.
   */
  readonly targetLanguage: string;
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
