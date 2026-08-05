import { z } from 'zod';
import { logger } from '../logger.ts';
import { SYSTEM_PROMPT, buildUserPrompt, currentDateLine } from '../prompts/layout.ts';
import { skipped } from './base.ts';
import type { Filter, FilterContext } from './base.ts';
import type { FilterResult } from '../types.ts';

/**
 * Is the rendered page BROKEN?
 *
 * The one question a text extractor genuinely cannot answer. It is deliberately
 * narrow: clipped text, overlap, garbled glyphs, rendering artifacts. It does
 * not grade taste, and it does not look at the job at all.
 *
 * Binary by design, like ContentLengthChecker and DataValidator. A 0-1
 * "professionalism" rating would invite thresholding an aesthetic opinion, and
 * measurement says that opinion is noise: across 26 runs of the combined filter
 * it replaces, the visual half never once reported a defect, while its taste
 * score was the sole cause of 4 of 6 failures. See docs/design-notes.md.
 */
const NAME = 'LayoutChecker';

export const layoutResult = z.object({
  broken: z.boolean().describe('True only if a visible rendering defect is present'),
  defects: z.array(z.string()).default([]).describe('One short line per visible defect'),
});

export type LayoutResult = z.infer<typeof layoutResult>;

export const layoutChecker: Filter = {
  name: NAME,
  priority: 8,

  evaluate: async ({ resume, chat }: FilterContext): Promise<FilterResult> => {
    const threshold = 1;

    // A provider that cannot accept images is a configuration fault, not a
    // defect in the CV. Report it as skipped rather than inventing a verdict.
    if (!chat.vision.supportsVision()) {
      logger.warn(
        `${NAME}: vision model ${chat.vision.model} cannot accept images - filter skipped, ` +
          `this is NOT a judgement about the CV`,
      );
      return skipped(NAME, threshold, `model ${chat.vision.model} has no vision support`);
    }

    // No page image is a real failure: a CV that will not render is broken.
    if (resume.pngPage1 === null) {
      return {
        filterName: NAME,
        passed: false,
        score: 0,
        threshold,
        issues: ['No rendered page image available'],
        suggestions: ['Ensure the resume renders before it is reviewed'],
      };
    }

    const system = `${SYSTEM_PROMPT}\n\n${currentDateLine()}`;
    const r = await chat.vision.object(
      { system, prompt: buildUserPrompt(resume.pageCount), image: resume.pngPage1 },
      layoutResult,
    );

    // A model that says "broken" and lists nothing has not found anything. Trust
    // the evidence, not the flag, and say so rather than failing a good CV on an
    // empty assertion.
    if (r.broken && r.defects.length === 0) {
      logger.warn(`${NAME}: reported broken=true with no defects listed - treating as not broken`);
    }
    const broken = r.broken && r.defects.length > 0;

    return {
      filterName: NAME,
      passed: !broken,
      score: broken ? 0 : 1,
      threshold,
      issues: broken ? r.defects : [],
      suggestions: broken ? ['Fix the rendering defects listed above'] : [],
    };
  },
};
