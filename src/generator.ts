import { Output, generateText, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import { logger } from './logger.ts';
import { checkKeywords } from './filters/keyword-matcher.ts';
import { validateMarkdown } from './filters/data-validator.ts';
import { buildSystemPrompt, buildUserPrompt, currentDateLine } from './prompts/optimizer.ts';
import type { FilterReport } from './prompts/optimizer.ts';
import type { Config } from './config.ts';
import { resolveModel } from './providers/ai-sdk.ts';
import type { Renderer } from './render/pdf.ts';
import type { JobPosting, OptimizedResume, ResumeSource } from './types.ts';

/**
 * The generator: turns a source CV and a job posting into resume markdown.
 *
 * This is the one part of the pipeline that IS an agent. The model calls tools,
 * reads the results and revises, in a loop. That is the right design here: the
 * model cannot know the page count without rendering, so it has to be able to
 * ask.
 *
 * The pipeline around it stays a plain loop. See docs/adr/0001.
 */

export const optimizerOutput = z.object({
  markdown: z.string().describe('The pandoc markdown, with the fenced blocks'),
  changes: z.array(z.string()).default([]).describe('List of changes made, for tracking'),
});

export type OptimizerOutput = z.infer<typeof optimizerOutput>;

/** Rough character and word counts, as `estimate_content_length` computes them. */
export const estimateLength = (markdown: string): { chars: number; words: number } => {
  // Strip what pandoc turns into layout rather than words: fences, the class
  // spans, link targets, heading and list markers, and the emphasis marks.
  const text = markdown
    .replace(/^:::.*$/gm, '')
    .replace(/\[([^\]]*)\]\{[^}]*\}/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[*-]\s+/gm, '')
    .replace(/\*\*?/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { chars: text.length, words: text.length === 0 ? 0 : text.split(' ').length };
};

/** What the caller must supply for one generation. */
export interface GenerateInput {
  readonly source: ResumeSource;
  readonly job: JobPosting;
  readonly iteration: number;
  readonly lastAttempt: string | null;
  readonly filterResults: readonly FilterReport[];
  readonly targetLanguage: string;
}

export interface GeneratorDeps {
  readonly renderer: Renderer;
  readonly config: Config;
}

/** Tracks whether the required length check ran, and whether it passed. */
interface CheckState {
  called: boolean;
  fits: boolean;
  pageCount: number | null;
  overflowIssue: string | null;
}

export const generate = async (
  input: GenerateInput,
  deps: GeneratorDeps,
): Promise<OptimizedResume> => {
  const { renderer, config } = deps;
  const state: CheckState = { called: false, fits: false, pageCount: null, overflowIssue: null };

  // The generator writes the CV, so it uses the pro model.
  const { model } = resolveModel(config.models.pro);

  const system = `${buildSystemPrompt({ noShame: config.noShame, targetChars: config.resume.targetChars, targetWords: config.resume.targetWords })}\n\n${currentDateLine()}`;

  const estimate = input.lastAttempt === null ? null : estimateLength(input.lastAttempt);
  const prompt = buildUserPrompt({
    originalResume: input.source.text,
    jobTitle: input.job.title,
    jobCompany: input.job.company,
    jobRequirements: input.job.requirements,
    jobKeywords: input.job.keywords,
    jobDescription: input.job.description,
    userInstructions: input.source.instructions,
    languageCode: input.targetLanguage,
    lastAttempt: input.lastAttempt,
    iteration: input.iteration,
    lastAttemptChars: estimate?.chars ?? 0,
    lastAttemptWords: estimate?.words ?? 0,
    filterResults: input.filterResults,
  });

  const tools = {
    /**
     * REQUIRED. Renders the markdown and reports the real page count.
     *
     * It mirrors the ContentLengthChecker filter exactly, including the
     * page-2 overflow rule, so the tool's verdict matches the filter that
     * will later gate the run. If the two disagreed, the model would be
     * chasing a target that does not exist.
     */
    check_content_length: tool({
      description:
        'Check if the markdown fits within the page limit (up to 2 pages) by rendering the PDF. Call before finalizing.',
      inputSchema: z.object({ markdown: z.string() }),
      execute: async ({ markdown }) => {
        const est = estimateLength(markdown);
        state.called = true;
        try {
          const out = await renderer.render(markdown);
          const page2 = (out.pageTexts[1] ?? '').trim();
          const overflow =
            out.pageCount === 2 &&
            page2.length > 0 &&
            page2.length < config.resume.page2OverflowChars
              ? `Page 2 has only ${page2.length} chars - content overflow from page 1`
              : null;

          state.fits = out.pageCount <= 2 && overflow === null;
          state.pageCount = out.pageCount;
          state.overflowIssue = overflow;

          logger.info(
            `  check_content_length: ${out.pageCount} pages, ${est.chars} chars, fits=${state.fits}`,
          );

          return {
            fits_page_limit: state.fits,
            page_count: out.pageCount,
            ...(overflow === null
              ? {}
              : {
                  overflow_issue: overflow,
                  suggestion:
                    'Page 2 is a near-empty overflow from page 1. Either add more relevant ' +
                    'content to fill page 2 properly, or trim slightly so everything fits on page 1.',
                }),
            estimates: {
              chars: est.chars,
              words: est.words,
              note: 'Character/word counts are rough estimates, page_count is authoritative',
            },
          };
        } catch (err: unknown) {
          state.fits = false;
          return {
            fits_page_limit: false,
            error: `Render failed: ${err instanceof Error ? err.message : String(err)}`,
            estimates: { chars: est.chars, words: est.words, note: 'Fix render error first' },
          };
        }
      },
    }),

    check_keywords_tool: tool({
      description:
        'Check keyword coverage vs job posting. Returns missing keywords ranked by TF-IDF importance.',
      inputSchema: z.object({ markdown: z.string() }),
      execute: ({ markdown }) => {
        const text = markdown.replace(/^:::.*$/gm, ' ');
        const r = checkKeywords(text, input.job, config.thresholds.keyword, config.keyword);
        return Promise.resolve({
          passed: r.passed,
          score: Math.round(r.score * 100) / 100,
          missing_keywords: [...r.missingKeywords],
        });
      },
    }),

    validate_structure: tool({
      description: 'Check the pandoc structure - name span, contacts and summary fences, balanced fences, no raw HTML.',
      inputSchema: z.object({ markdown: z.string() }),
      execute: ({ markdown }) => {
        const issues = validateMarkdown(markdown);
        return Promise.resolve({ valid: issues.length === 0, issues });
      },
    }),
  };

  /**
   * A framework output validator could enforce the length check
   * that raises ModelRetry. The AI SDK has no equivalent, so the retry is an
   * explicit loop here.
   */
  const messages: { role: 'user' | 'assistant'; content: string }[] = [
    { role: 'user', content: prompt },
  ];

  for (let attempt = 1; attempt <= config.optimizer.retries; attempt++) {
    const result = await generateText({
      model,
      system,
      messages,
      tools,
      stopWhen: stepCountIs(config.optimizer.maxSteps),
      output: Output.object({ schema: optimizerOutput }),
    });

    const out = result.output;

    if (state.called && state.fits) {
      return {
        markdown: out.markdown,
        pdfText: null,
        pngPage1: null,
        pageCount: null,
        pageTexts: null,
      };
    }

    const retry = !state.called
      ? 'You must call check_content_length(markdown) with your final markdown before returning. ' +
        'Call it now to verify the resume fits within the page limit (max 2 pages).'
      : state.overflowIssue !== null
        ? `check_content_length reported: ${state.overflowIssue} ` +
          'Either add more relevant content to fill page 2 properly, or trim slightly so ' +
          'everything fits on page 1. Call check_content_length again until fits_page_limit=True, then return.'
        : `check_content_length returned page_count=${state.pageCount} — exceeds the 2-page limit. ` +
          'Trim content and call check_content_length again until fits_page_limit=True, then return.';

    logger.info(`  attempt ${attempt} rejected: ${retry.split('.')[0] ?? ''}`);
    messages.push({ role: 'assistant', content: out.markdown });
    messages.push({ role: 'user', content: retry });
  }

  throw new Error(
    `generator: gave up after ${config.optimizer.retries} attempts. The model never produced ` +
      `HTML that passed check_content_length. Last page count: ${state.pageCount ?? 'unknown'}.`,
  );
};
