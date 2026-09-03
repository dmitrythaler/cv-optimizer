import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from './logger.ts';
import { version } from './version.ts';
import {
  ERRORS_LOG,
  ITERATION_PDF,
  ITERATION_PNG,
  OPTIMIZATION_JSON,
  naming,
  renderCvName,
} from './output-path.ts';
import type { CleanReport } from './job-text.ts';
import type { Config } from './config.ts';
import type { Renderer } from './render/pdf.ts';
import type { JobPosting, OptimizationOutcome, ResumeSource } from './types.ts';

/**
 * Writes everything one run produced into one folder.
 *
 * Every iteration is kept, not only the failing ones. When a run fails you look
 * through them to pick an attempt by hand; when it passes you still want to see
 * what it took to get there.
 */

export interface PreparedRun {
  readonly folder: string;
  readonly cvName: string;
}

/**
 * Creates the run folder and stores the job description in it, BEFORE the run
 * starts.
 *
 * Order matters. The folder is named after the company and the role, so the
 * posting has to be fetched and parsed first. Once it is, `jd.txt` is written
 * at once - a run that dies after twenty minutes must not also lose the text it
 * was working from.
 */
export const prepareRun = async (
  outputDir: string,
  job: JobPosting,
  config: Config,
): Promise<PreparedRun> => {
  const n = naming(job.company || 'unknown', job.title || null, job.language);
  const cvName = renderCvName(config.cvNameTemplate, n);
  await mkdir(outputDir, { recursive: true });
  return { folder: outputDir, cvName };
};

export interface WriteRunInput {
  readonly prepared: PreparedRun;
  readonly outcome: OptimizationOutcome;
  readonly job: JobPosting;
  readonly source: ResumeSource;
  readonly renderer: Renderer;
  readonly config: Config;
  /** `Date.now()` at the start of the run, for the recorded duration. */
  readonly startedAt: number;
  /** Where the posting came from. Recorded in optimization.json. */
  readonly jobSource: JobSource;
}

export interface JobSource {
  /** The URL fetched, or the path of the file read. */
  readonly from: string;
  readonly kind: 'url' | 'file';
  readonly method?: 'request' | 'browser';
  /** How the posting was separated from the page. See fetch-job.ts. */
  readonly strategy?: 'json-ld' | 'cleaned-html';
  readonly clean?: CleanReport | null;
}

export interface WriteRunResult {
  readonly folder: string;
  readonly cvFile: string;
  readonly pageCount: number | null;
}

export const writeRun = async (input: WriteRunInput): Promise<WriteRunResult> => {
  const { outcome, job, source, renderer, config } = input;
  const { folder, cvName } = input.prepared;

  // Render each iteration once. The filed iteration's bytes are also the CV, so
  // nothing is rendered twice.
  const iterations: unknown[] = [];
  let cvBytes: Uint8Array | null = null;
  let cvPages: number | null = null;

  for (const it of outcome.iterations) {
    let pdfFile: string | null = null;
    let pngFile: string | null = null;
    let pages: number | null = it.resume.pageCount;

    if (it.resume.markdown !== '') {
      try {
        const r = await renderer.render(it.resume.markdown);
        pdfFile = ITERATION_PDF(it.n);
        pngFile = ITERATION_PNG(it.n);
        pages = r.pageCount;
        await writeFile(join(folder, pdfFile), r.pdf);
        await writeFile(join(folder, pngFile), r.pngPage1);
        if (it.n === outcome.filed.n) {
          cvBytes = r.pdf;
          cvPages = r.pageCount;
        }
      } catch (err: unknown) {
        // Say so. A missing iteration file with no explanation is the kind of
        // gap that sends you looking for a bug in the wrong place.
        logger.error(
          `could not write iteration ${it.n}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    iterations.push({
      n: it.n,
      passed: it.passed,
      pageCount: pages,
      pdf: pdfFile,
      png: pngFile,
      filters: it.results.map((r) => ({
        name: r.filterName,
        score: Number.isNaN(r.score) ? null : r.score,
        threshold: Number.isNaN(r.threshold) ? null : r.threshold,
        passed: r.passed,
        skipped: Number.isNaN(r.score),
        issues: r.issues,
        suggestions: r.suggestions,
      })),
    });
  }

  if (cvBytes === null) {
    // The filed iteration produced no PDF: the generator never converged, or
    // rendering failed. There is no CV to write, and pretending otherwise would
    // leave a zero-byte file that looks like a result.
    logger.error(
      `no renderable CV for the filed iteration ${outcome.filed.n} - ${cvName} not written`,
    );
  } else {
    await writeFile(join(folder, cvName), cvBytes);
  }

  const problems = logger.problems();

  const report = {
    version,
    generatedAt: new Date().toISOString(),
    durationSeconds: Number(((Date.now() - input.startedAt) / 1000).toFixed(1)),
    passed: outcome.passed,
    failedFilters: outcome.failedFilters,
    filedIteration: outcome.filed.n,
    cvFile: cvBytes === null ? null : cvName,
    job: {
      title: job.title,
      company: job.company,
      language: job.language,
      requirements: job.requirements,
      keywords: job.keywords,
      // Where the text in jd.txt came from, and what the cleaner removed.
      source: input.jobSource,
    },
    source: { path: source.path, chars: source.text.length, instructions: source.instructions },
    settings: {
      models: config.models,
      embeddingModel: config.embedding.model,
      maxIterations: config.maxIterations,
      noShame: config.noShame,
      thresholds: config.thresholds,
      cvNameTemplate: config.cvNameTemplate,
    },
    iterations,
    errors: problems,
  };
  await writeFile(join(folder, OPTIMIZATION_JSON), `${JSON.stringify(report, null, 2)}\n`);

  // Written only when there was something to report.
  if (problems.length > 0) {
    await writeFile(join(folder, ERRORS_LOG), `${problems.join('\n')}\n`);
  }

  return { folder, cvFile: cvName, pageCount: cvPages };
};
