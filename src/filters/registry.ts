import { logger } from '../logger.ts';
import type { Filter, FilterContext } from './base.ts';
import type { FilterResult } from '../types.ts';

const registry: Filter[] = [];

/** Register a filter. Lower `priority` runs first. */
export const register = (filter: Filter): void => {
  if (registry.some((f) => f.name === filter.name)) {
    throw new Error(`duplicate filter name: ${filter.name}`);
  }
  registry.push(filter);
  registry.sort((a, b) => a.priority - b.priority);
};

export const all = (): readonly Filter[] => registry;

/**
 * A filter that threw. The Python turns an exception into a FAILED result, not
 * a skip: a throw is a bug in the filter, and a bug must not read as approval.
 *
 * This is different from `skipped()`, which a filter returns on purpose when it
 * knows it cannot judge, for example when a provider has no vision.
 */
const asFailure = (filter: Filter, err: unknown): FilterResult => ({
  filterName: filter.name,
  passed: false,
  score: 0.0,
  threshold: 0.5,
  issues: [`Filter error: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`],
  suggestions: ['Check filter implementation'],
});

export interface RunOptions {
  /** Sequential stops at the first failure. Parallel runs everything. */
  readonly sequential?: boolean;
}

/**
 * Runs every registered filter.
 *
 * Port of `run_filters()` in hr-breaker `orchestration.py`.
 *
 * Parallel is the default and the normal mode. Sequential exists for
 * debugging: it runs in priority order and stops at the first failure, so the
 * log ends at the thing that broke.
 *
 * NOT ported: the Python skips filters with priority >= 100 once something has
 * failed, and does not early-exit on them. No such filter exists - the highest
 * is 7 - so the branch is dead. See docs/porting-notes.md.
 */
export const runAll = async (
  ctx: FilterContext,
  opts: RunOptions = {},
): Promise<FilterResult[]> => {
  if (opts.sequential === true) {
    const out: FilterResult[] = [];
    for (const f of registry) {
      try {
        const r = await f.evaluate(ctx);
        out.push(r);
        if (!r.passed) break;
      } catch (err: unknown) {
        logger.error(`Filter ${f.name} raised exception: ${String(err)}`);
        out.push(asFailure(f, err));
        break;
      }
    }
    return out;
  }

  const settled = await Promise.allSettled(registry.map((f) => f.evaluate(ctx)));
  return settled.map((s, i) => {
    const f = registry[i] as Filter;
    if (s.status === 'fulfilled') return s.value;
    logger.error(`Filter ${f.name} raised exception: ${String(s.reason)}`);
    return asFailure(f, s.reason);
  });
};
