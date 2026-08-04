import { z } from 'zod';
import { logger } from '../logger.ts';
import { SYSTEM_PROMPT, buildUserPrompt, currentDateLine } from '../prompts/vision.ts';
import { skipped } from './base.ts';
import type { Filter, FilterContext } from './base.ts';
import type { FilterResult } from '../types.ts';

/**
 * Renamed from hr-breaker's `LLMChecker`, which said nothing about what it does.
 * The old name still appears in historical `cv_failed_filters` entries in
 * ../results.json - see docs/porting-notes.md.
 */
const NAME = 'VisionChecker';

/** Mirrors `CombinedReviewResult` in agents/combined_reviewer.py. */
export const visionResult = z.object({
  looks_professional: z.boolean().describe('True if resume looks professional'),
  visual_issues: z.array(z.string()).default([]).describe('List of visual/formatting issues found'),
  visual_feedback: z
    .string()
    .default('')
    .describe('Free-form description of visual issues and suggestions'),
  keyword_score: z.number().min(0).max(1).describe('Keyword/skills match rate'),
  experience_score: z.number().min(0).max(1).describe('Experience alignment'),
  education_score: z.number().min(0).max(1).describe('Education fit'),
  overall_fit_score: z.number().min(0).max(1).describe('Holistic fit for the role'),
  disqualified: z.boolean().describe('Auto-reject triggered'),
  ats_issues: z.array(z.string()).default([]).describe('ATS-related issues'),
});

export type VisionResult = z.infer<typeof visionResult>;

/** `SCORE_WEIGHTS` from combined_reviewer.py. Sums to 1.0. */
export const SCORE_WEIGHTS = {
  keyword: 0.25,
  experience: 0.175,
  education: 0.075,
  overallFit: 0.5,
} as const;

/** Port of `compute_ats_score()`. */
export const computeAtsScore = (r: VisionResult): number =>
  r.keyword_score * SCORE_WEIGHTS.keyword +
  r.experience_score * SCORE_WEIGHTS.experience +
  r.education_score * SCORE_WEIGHTS.education +
  r.overall_fit_score * SCORE_WEIGHTS.overallFit;

/**
 * Renders-and-judges: one model call doing both a visual quality check on the
 * rendered page image and an ATS screening on the extracted text.
 *
 * Ported from hr-breaker `filters/llm_checker.py` + `agents/combined_reviewer.py`.
 * SYSTEM_PROMPT is verbatim (see ../prompts/vision.ts).
 *
 * IMPORTANT, and the reason this filter has a bad reputation: the reported
 * score is `atsScore` only when `looks_professional` is true, and hard 0.0
 * otherwise. So a **0.00 never means "the ATS rejected you"** - it means the
 * vision half said no, and the ATS numbers were thrown away. In hr-breaker that
 * happened whenever the page image failed to reach the model, which made a
 * plumbing fault look like a bad CV for weeks. See docs/porting-notes.md.
 *
 * This port keeps that scoring rule for parity but refuses to guess when it
 * cannot actually see the page - see the two guards below.
 */
export const visionChecker: Filter = {
  name: NAME,
  priority: 5,

  evaluate: async ({
    resume,
    job,
    config,
    chat,
    targetLanguage,
  }: FilterContext): Promise<FilterResult> => {
    const threshold = config.thresholds.vision;

    // Guard 1: the provider cannot do vision at all. That is a configuration
    // fault, not a defect in the CV, so report it as skipped rather than
    // inventing a verdict. hr-breaker had no such distinction.
    if (!chat.supportsVision()) {
      logger.warn(
        `${NAME}: chat provider ${chat.model} cannot accept images - filter skipped, ` +
          `this is NOT a judgement about the CV`,
      );
      return skipped(NAME, threshold, `provider ${chat.model} has no vision support`);
    }

    // Guard 2: rendering produced no page image. Unlike guard 1 this IS a
    // defect - a CV that will not render is broken - and hr-breaker fails it
    // too (via looks_professional=false, disqualified=true, page_count=0).
    if (resume.pngPage1 === null) {
      return {
        filterName: NAME,
        passed: false,
        score: 0.0,
        threshold,
        issues: ['No rendered page image available'],
        suggestions: ['Ensure the resume renders before it is reviewed'],
      };
    }

    const system = `${SYSTEM_PROMPT}\n\n${currentDateLine()}`;
    const prompt = buildUserPrompt({
      jobTitle: job.title,
      jobCompany: job.company,
      jobDescription: job.description,
      jobRequirements: job.requirements,
      jobKeywords: job.keywords,
      // The Python falls back html -> data -> "(no content)"; this port is
      // HTML-only, so the structured branch cannot arise.
      resumeText: resume.pdfText || resume.html || '(no content)',
      languageCode: targetLanguage,
    });

    const r = await chat.object({ system, prompt, image: resume.pngPage1 }, visionResult);

    const atsScore = computeAtsScore(r);
    const passed = r.looks_professional && atsScore >= threshold && !r.disqualified;

    if (!r.looks_professional) {
      logger.warn(
        `${NAME}: vision model judged looks_professional=false - ` +
          `issues=${JSON.stringify(r.visual_issues)} feedback=${JSON.stringify(r.visual_feedback)}`,
      );
    }

    const suggestions: string[] = [];
    if (!r.looks_professional) suggestions.push('Fix visual/formatting issues');
    if (atsScore < threshold) {
      suggestions.push(`Improve ATS match (score: ${atsScore.toFixed(2)}, need: ${threshold})`);
    }
    if (r.disqualified) suggestions.push('Address disqualifying issues');

    return {
      filterName: NAME,
      passed,
      // Parity with the Python: the ATS score is discarded when the visual
      // check fails. Kept so scores remain comparable across the two versions.
      score: r.looks_professional ? atsScore : 0.0,
      threshold,
      issues: [...r.visual_issues, ...r.ats_issues],
      suggestions,
    };
  },
};
