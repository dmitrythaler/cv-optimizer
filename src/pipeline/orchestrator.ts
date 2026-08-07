import { logger } from '../logger.ts';
import { runAll } from '../filters/registry.ts';
import type { FilterReport } from '../prompts/optimizer.ts';
import type { Config } from '../config.ts';
import type { GenerateInput } from '../generator.ts';
import type { FilterContext } from '../filters/base.ts';
import type { EmbeddingProvider } from '../providers/embeddings.ts';
import type { ChatProviders } from '../providers/ai-sdk.ts';
import type { Renderer } from '../render/pdf.ts';
import type {
  FilterResult,
  Iteration,
  JobPosting,
  OptimizationOutcome,
  OptimizedResume,
  ResumeSource,
} from '../types.ts';

/** Produces one candidate CV. `generator.ts` supplies the real one. */
export interface Generator {
  (input: GenerateInput): Promise<OptimizedResume>;
}

export interface OptimizeDeps {
  readonly generate: Generator;
  readonly renderer: Renderer;
  readonly chat: ChatProviders;
  readonly embeddings: EmbeddingProvider;
  readonly config: Config;
  /** Run filters one at a time and stop at the first failure. For debugging. */
  readonly sequential?: boolean;
  /** Called after each iteration is graded. For progress reporting. */
  readonly onIteration?: (it: Iteration) => void;
}

/** A filter result that stands for a step that failed before any filter ran. */
const syntheticFailure = (name: string, issue: string, suggestion: string): FilterResult => ({
  filterName: name,
  passed: false,
  score: 0.0,
  threshold: 1.0,
  issues: [issue],
  suggestions: [suggestion],
});

/** A NaN score marks a filter that declined to judge. The prompt leaves those out. */
const toReports = (results: readonly FilterResult[]): FilterReport[] =>
  results.map((r) => ({
    filterName: r.filterName,
    passed: r.passed,
    score: r.score,
    threshold: r.threshold,
    issues: r.issues,
    suggestions: r.suggestions,
    skipped: Number.isNaN(r.score),
  }));

/**
 * The generate, render, grade loop.
 *
 * Each round: generate a CV, render it, extract the text and the page image,
 * grade it with every filter. Stop on the first fully passing round. Otherwise
 * feed the failures back and try again, until the iteration budget runs out.
 *
 * There is no model in this control flow. The steps are fixed and nothing here
 * makes a judgement. See docs/adr/0001.
 *
 * `filed` is the LAST iteration, which is the passing one when the loop broke
 * early. It is NOT the best iteration - nothing here tries to pick one. Every
 * iteration is returned, so a caller can look back over them by hand.
 */
export const optimize = async (
  source: ResumeSource,
  job: JobPosting,
  deps: OptimizeDeps,
): Promise<OptimizationOutcome> => {
  const { generate, renderer, chat, embeddings, config } = deps;

  const iterations: Iteration[] = [];
  let lastAttempt: string | null = null;
  let results: FilterResult[] = [];

  for (let i = 0; i < config.maxIterations; i++) {
    logger.info(`Iteration ${i + 1}/${config.maxIterations}`);

    let resume: OptimizedResume;
    try {
      logger.info('  generating CV …');
      resume = await generate({
        source,
        job,
        iteration: i,
        lastAttempt,
        filterResults: toReports(results),
        targetLanguage: job.language,
      });
    } catch (err: unknown) {
      // The generator's own page-fit loop can fail to converge under tight or
      // conflicting instructions. End the run cleanly and keep what the last
      // good iteration produced, rather than throwing the whole run away.
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Iteration ${i + 1} aborted: the generator did not converge (${msg})`);
      if (iterations.length === 0) {
        results = [
          syntheticFailure(
            'Optimizer',
            `Optimizer failed to produce usable output: ${msg}`,
            'Relax conflicting instructions or constraints, or raise OPTIMIZER_RETRIES',
          ),
        ];
        iterations.push({
          n: i + 1,
          resume: { html: '', pdfText: null, pngPage1: null, pageCount: null, pageTexts: null },
          results,
          passed: false,
        });
      }
      break;
    }

    lastAttempt = resume.html;

    // Grade the RENDERED document, not the HTML. What an ATS pulls out of the
    // PDF is what matters, and it differs from what the markup implies.
    logger.info('  rendering PDF …');
    try {
      const out = await renderer.render(resume.html);
      resume = {
        html: resume.html,
        pdfText: out.text,
        pngPage1: out.pngPage1,
        pageCount: out.pageCount,
        pageTexts: out.pageTexts,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Iteration ${i + 1}: rendering failed (${msg})`);
      results = [
        syntheticFailure('PDFRender', 'Failed to render resume to PDF', 'Check the resume HTML'),
      ];
      iterations.push({ n: i + 1, resume, results, passed: false });
      deps.onIteration?.(iterations[iterations.length - 1] as Iteration);
      continue;
    }

    const ctx: FilterContext = {
      resume,
      job,
      source,
      config,
      chat,
      embeddings,
      targetLanguage: job.language,
    };
    results = await runAll(ctx, { sequential: deps.sequential ?? false });
    const passed = results.every((r) => r.passed);

    const iteration: Iteration = { n: i + 1, resume, results, passed };
    iterations.push(iteration);
    deps.onIteration?.(iteration);

    logger.info(
      `  ${results
        .map(
          (r) =>
            `${r.filterName}:${Number.isNaN(r.score) ? '-' : r.score.toFixed(2)}/` +
            `${r.threshold.toFixed(2)}${r.passed ? '+' : '-'}`,
        )
        .join(' ')}`,
    );

    if (passed) break;
  }

  const filed = iterations[iterations.length - 1];
  if (filed === undefined) throw new Error('optimize(): no iterations ran');

  return {
    iterations,
    filed,
    passed: filed.passed,
    failedFilters: filed.results.filter((r) => !r.passed).map((r) => r.filterName),
  };
};
