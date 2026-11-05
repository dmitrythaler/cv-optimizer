import { logger } from '../logger.ts';
import { ProviderUnavailableError, providerFault } from '../providers/provider-error.ts';
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
 * A filter that threw. An exception becomes a FAILED result, not
 * a skip: a throw is a bug in the filter, and a bug must not read as approval.
 *
 * This is different from `skipped()`, which a filter returns on purpose when it
 * knows it cannot judge, for example when a provider has no vision.
 *
 * It is also different from a PROVIDER fault - an empty wallet, a bad key, a
 * refused call. That error says nothing about the CV, so it must not read as
 * rejection either. `raise()` sends those up instead. See provider-error.ts.
 */
const asFailure = (filter: Filter, err: unknown): FilterResult => ({
  filterName: filter.name,
  passed: false,
  score: 0.0,
  threshold: 0.5,
  issues: [`Filter error: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`],
  suggestions: ['Check filter implementation'],
});

/**
 * Ends the run when the provider is the thing that broke. Returns a FAILED
 * result for every other exception, which is a bug in the filter itself.
 */
const raise = (filter: Filter, err: unknown): FilterResult => {
  const fault = providerFault(err);
  if (fault !== null) throw new ProviderUnavailableError(filter.name, fault, err);
  return asFailure(filter, err);
};

export interface RunOptions {
  /** Sequential stops at the first failure. Parallel runs everything. */
  readonly sequential?: boolean;
}

/**
 * Runs every registered filter.
 *
 *
 * Parallel is the default and the normal mode. Sequential exists for
 * debugging: it runs in priority order and stops at the first failure, so the
 * log ends at the thing that broke.
 *
 * Deliberately absent: skipping filters with priority >= 100 once something has
 * failed, and does not early-exit on them. No such filter exists - the highest
 * is 7 - so the branch would be dead. See docs/design-notes.md.
 */
export const runAll = async (
  ctx: FilterContext,
  opts: RunOptions = {},
): Promise<FilterResult[]> => {
  if (opts.sequential === true) {
    const out: FilterResult[] = [];
    for (const f of registry) {
      logger.info(`  running ${f.name} …`);
      try {
        const r = await f.evaluate(ctx);
        logger.info(
          `  ${f.name}: ${Number.isNaN(r.score) ? 'skipped' : r.score.toFixed(2)}/${r.threshold.toFixed(2)}${r.passed ? ' PASS' : ' FAIL'}`,
        );
        out.push(r);
        if (!r.passed) break;
      } catch (err: unknown) {
        logger.error(`Filter ${f.name} raised exception: ${String(err)}`);
        out.push(raise(f, err));
        break;
      }
    }
    return out;
  }

  logger.info(`  grading with ${registry.length} filters …`);
  const settled = await Promise.allSettled(
    registry.map(async (f) => {
      logger.info(`    ${f.name} …`);
      try {
        const r = await f.evaluate(ctx);
        const label = Number.isNaN(r.score)
          ? 'SKIPPED'
          : `${r.score.toFixed(2)}/${r.threshold.toFixed(2)}${r.passed ? ' PASS' : ' FAIL'}`;
        if (r.passed) {
          logger.info(`    ${f.name}: ${label}`);
        } else {
          logger.warn(`    ${f.name}: ${label}`);
          for (const issue of r.issues) logger.warn(`      ${issue}`);
        }
        return r;
      } catch (err: unknown) {
        logger.error(`    ${f.name}: exception — ${String(err)}`);
        throw err;
      }
    }),
  );
  // Every filter ran, so a provider fault is reported once the whole round is
  // in. That keeps the log complete: the other filters' scores still print.
  return settled.map((s, i) => {
    const f = registry[i] as Filter;
    if (s.status === 'fulfilled') return s.value;
    logger.error(`Filter ${f.name} raised exception: ${String(s.reason)}`);
    return raise(f, s.reason);
  });
};
