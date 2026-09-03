import { z } from 'zod';
import { SYSTEM_PROMPT, buildUserPrompt, currentDateLine } from '../prompts/ats.ts';
import type { Filter, FilterContext } from './base.ts';
import type { FilterResult } from '../types.ts';

/**
 * ATS screening, from the extracted TEXT of the rendered PDF.
 *
 * An applicant tracking system parses text. Grading ATS fit from a picture of
 * the page is less faithful to what is being simulated, and it drags in a
 * second vendor for no signal - see docs/design-notes.md for the numbers.
 *
 * Runs on the CHEAP model. It needs no vision support, so the whole pipeline
 * can sit on one provider.
 */
const NAME = 'AtsChecker';

export const atsResult = z.object({
  keyword_score: z.number().min(0).max(1).describe('Keyword/skills match rate'),
  experience_score: z.number().min(0).max(1).describe('Experience alignment'),
  education_score: z.number().min(0).max(1).describe('Education fit'),
  overall_fit_score: z.number().min(0).max(1).describe('Holistic fit for the role'),
  disqualified: z.boolean().describe('Auto-reject triggered'),
  ats_issues: z.array(z.string()).default([]).describe('ATS-related issues'),
});

export type AtsResult = z.infer<typeof atsResult>;

/** Sums to 1.0. Half the score is one holistic judgement. */
export const SCORE_WEIGHTS = {
  keyword: 0.25,
  experience: 0.175,
  education: 0.075,
  overallFit: 0.5,
} as const;

export const computeAtsScore = (r: AtsResult): number =>
  r.keyword_score * SCORE_WEIGHTS.keyword +
  r.experience_score * SCORE_WEIGHTS.experience +
  r.education_score * SCORE_WEIGHTS.education +
  r.overall_fit_score * SCORE_WEIGHTS.overallFit;

export const atsChecker: Filter = {
  name: NAME,
  priority: 5,

  evaluate: async ({
    resume,
    job,
    config,
    chat,
    targetLanguage,
  }: FilterContext): Promise<FilterResult> => {
    const threshold = config.thresholds.ats;

    const system = `${SYSTEM_PROMPT}\n\n${currentDateLine()}`;
    const prompt = buildUserPrompt({
      jobTitle: job.title,
      jobCompany: job.company,
      // The brief summary, or the whole posting when there is none.
      jobDescription: job.description || job.rawText,
      jobRequirements: job.requirements,
      jobKeywords: job.keywords,
      resumeText: resume.pdfText || resume.markdown || '(no content)',
      languageCode: targetLanguage,
    });

    const r = await chat.flash.object({ system, prompt }, atsResult);

    const score = computeAtsScore(r);
    // `disqualified` is a hard requirement the posting states and the CV does
    // not meet. It is not an opinion about quality, so it overrides the score.
    const passed = score >= threshold && !r.disqualified;

    const suggestions: string[] = [];
    if (score < threshold) {
      suggestions.push(`Improve ATS match (score: ${score.toFixed(2)}, need: ${threshold})`);
    }
    if (r.disqualified) suggestions.push('Address disqualifying issues');

    return {
      filterName: NAME,
      passed,
      // Always the real score. Nothing zeroes it out - a caller can tell a weak
      // match from a hard disqualification by reading `passed` and the issues.
      score,
      threshold,
      issues: r.ats_issues,
      suggestions,
    };
  },
};
