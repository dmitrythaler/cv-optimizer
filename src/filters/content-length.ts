import type { Filter, FilterContext } from './base.ts';
import type { FilterResult } from '../types.ts';

const NAME = 'ContentLengthChecker';
const THRESHOLD = 1.0;

const pass = (): FilterResult => ({
  filterName: NAME,
  passed: true,
  score: 1.0,
  threshold: THRESHOLD,
  issues: [],
  suggestions: [],
});

const fail = (issues: string[], suggestions: string[]): FilterResult => ({
  filterName: NAME,
  passed: false,
  score: 0.0,
  threshold: THRESHOLD,
  issues,
  suggestions,
});

/**
 * Page-fit check. Runs first so an oversized CV fails before anything is paid for.
 *
 * Behaviour:
 *  - unrendered input passes (nothing to measure yet)
 *  - more than 2 pages fails
 *  - exactly 2 pages fails IF page 2 holds some text but less than
 *    `page2OverflowChars` - that is spillover from page 1, not a real second page
 *  - an empty page 2 (0 chars) passes, matching the original's `len > 0` guard
 *
 * Two things are deliberate rather than oversights - see docs/design-notes.md:
 *  - the >2 message says "must be 1 page" while the check allows 2. The message
 *    is stale; the behaviour is what callers depend on.
 *  - an earlier design re-rendered inside the filter. Here the pipeline renders
 *    once and passes the result down, so this filter only reads.
 */
export const contentLength: Filter = {
  name: NAME,
  priority: 0,

  evaluate: ({ resume, config }: FilterContext): Promise<FilterResult> => {
    if (resume.pageCount === null) return Promise.resolve(pass());

    if (resume.pageCount > 2) {
      return Promise.resolve(
        fail(
          [`Resume is ${resume.pageCount} pages - must be 1 page`],
          ['Reduce content to fit within 1 page'],
        ),
      );
    }

    if (resume.pageCount === 2) {
      const page2 = (resume.pageTexts?.[1] ?? '').trim();
      if (page2.length > 0 && page2.length < config.resume.page2OverflowChars) {
        return Promise.resolve(
          fail(
            [`Page 2 has only ${page2.length} chars - content overflow from page 1`],
            ['Content overflows to page 2'],
          ),
        );
      }
    }

    return Promise.resolve(pass());
  },
};
