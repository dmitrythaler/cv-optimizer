import { z } from 'zod';
import { SYSTEM_PROMPT, buildUserPrompt, currentDateLine } from '../prompts/ai-generated.ts';
import type { Filter, FilterContext } from './base.ts';
import type { FilterResult } from '../types.ts';

const NAME = 'AiGeneratedChecker';

/** The same shape as `AIGeneratedResult` in agents/ai_generated_detector.py. */
export const aiGeneratedResult = z.object({
  is_ai_generated: z.boolean().describe('True if resume appears AI-generated'),
  ai_probability: z
    .number()
    .min(0)
    .max(1)
    .describe('Probability that content is AI-generated (0-1)'),
  indicators: z
    .array(z.string())
    .default([])
    .describe('Specific indicators of AI generation found'),
});

export type AiGeneratedResult = z.infer<typeof aiGeneratedResult>;

/**
 * Looks for signs that a model wrote the CV.
 *
 * Pairs with
 * `agents/ai_generated_detector.py`. The prompt is a copy, byte for byte.
 *
 * The score is INVERTED: `score = 1 - ai_probability`. A high score means the
 * text looks human. This is easy to read the wrong way. All other filters use
 * "high is good" too, so the direction is correct, but the model reports the
 * opposite quantity.
 *
 * The prompt is careful about false positives. A CV is formulaic on purpose.
 * Action verbs, equal bullet lengths and metrics are good practice, not tells.
 * The prompt flags only impossible claims, contradictions, empty buzzwords and
 * repeated filler.
 *
 * NOTE: the model also returns `is_ai_generated`. It is deliberately ignored -
 * the decision rests on the score alone. See docs/design-notes.md.
 */
export const aiGenerated: Filter = {
  name: NAME,
  priority: 7,

  evaluate: async ({
    resume,
    config,
    chat,
    targetLanguage,
  }: FilterContext): Promise<FilterResult> => {
    // Lenient mode halves the threshold.
    const threshold = config.noShame
      ? config.thresholds.aiGenerated / 2
      : config.thresholds.aiGenerated;

    const system = `${SYSTEM_PROMPT}\n\n${currentDateLine()}`;
    const prompt = buildUserPrompt({
      // Order: pdf_text, then html, then structured data. This
      // port has no structured data, so the last branch cannot occur.
      resumeText: resume.pdfText || resume.html || '(no content)',
      languageCode: targetLanguage,
    });

    const r = await chat.flash.object({ system, prompt }, aiGeneratedResult);

    const score = 1.0 - r.ai_probability;

    const issues = r.indicators.map((i) => `AI giveaway: ${i}`);
    const suggestions =
      r.indicators.length > 0
        ? [
            'Fix AI tells: vary bullet lengths/structure, add specific details ' +
              'instead of generic claims, introduce minor style variations',
          ]
        : [];

    return {
      filterName: NAME,
      passed: score >= threshold,
      score,
      threshold,
      issues,
      suggestions,
    };
  },
};
