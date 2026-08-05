import { z } from 'zod';
import type { Filter, FilterContext } from './base.ts';
import type { FilterResult } from '../types.ts';
import {
  LENIENT_PROMPT,
  STRICT_PROMPT,
  buildUserPrompt,
  currentDateLine,
} from '../prompts/hallucination.ts';

const NAME = 'HallucinationChecker';

/** Mirrors `HallucinationResult` in agents/hallucination_detector.py. */
export const hallucinationResult = z.object({
  no_hallucination_score: z
    .number()
    .min(0)
    .max(1)
    .describe('Score from 0 to 1 where 1.0 = no fabrications, 0.0 = severe fabrications'),
  concerns: z
    .array(z.string())
    .default([])
    .describe('List of potential concerns (may include minor acceptable additions)'),
  reasoning: z.string().describe('Brief explanation of the score'),
});

export type HallucinationResult = z.infer<typeof hallucinationResult>;

/**
 * Detects claims in the generated CV that the source does not support.
 *
 * Pairs with
 * `agents/hallucination_detector.py`. Both prompts are copied verbatim into
 * ../prompts/hallucination.ts.
 *
 * This is the filter that actually protects you: the optimizer will invent
 * domain experience to chase KeywordMatcher, and this is what catches it. A
 * falling score across iterations means fabrication is creeping in.
 *
 * One deliberate choice, see docs/design-notes.md: elsewhere `passed` is
 * computed against a hardcoded threshold (0.9 strict / 0.6 lenient) while the
 * reported `threshold` is then overwritten from settings - so raising or
 * lowering FILTER_HALLUCINATION_THRESHOLD changed the displayed number but not
 * the verdict. Here one threshold drives both.
 */
export const hallucination: Filter = {
  name: NAME,
  priority: 3,

  evaluate: async ({
    resume,
    source,
    config,
    chat,
    targetLanguage,
  }: FilterContext): Promise<FilterResult> => {
    const noShame = config.noShame;
    // 0.6 is the fixed lenient bound; strict mode is configurable.
    const threshold = noShame ? 0.6 : config.thresholds.hallucination;

    const system = `${noShame ? LENIENT_PROMPT : STRICT_PROMPT}\n\n${currentDateLine()}`;
    const prompt = buildUserPrompt({
      sourceContent: source.text,
      sourceInstructions: source.instructions,
      // The fallback chain ends at structured data, then "(no content)". This
      // port is HTML-only, so the fallback cannot arise.
      optimizedContent: resume.html || '(no content)',
      languageCode: targetLanguage,
    });

    const r = await chat.pro.object({ system, prompt }, hallucinationResult);

    const issues = [...r.concerns];
    const suggestions: string[] = [];
    if (r.no_hallucination_score < threshold) {
      suggestions.push(
        `Score ${r.no_hallucination_score.toFixed(2)} below ${threshold} threshold. ${r.reasoning}`,
      );
    }

    return {
      filterName: NAME,
      passed: r.no_hallucination_score >= threshold,
      score: r.no_hallucination_score,
      threshold,
      issues,
      suggestions,
    };
  },
};
