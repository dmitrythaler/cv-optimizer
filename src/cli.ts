#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { loadConfig } from './config.ts';
import { logger } from './logger.ts';
import { version } from './version.ts';

const USAGE = `cv-optimizer - tailor a CV to a job description

USAGE
  cv-optimizer optimize <cv-file> <jd-file|url> [options]
  cv-optimizer fetch-job <url> <out-file>
  cv-optimizer pull-model
  cv-optimizer calibrate-vector <cv-file> <jd-glob-dir>
  cv-optimizer check-filters <cv-file> <jd-file> <filter[,filter...]|all>
  cv-optimizer filters
  cv-optimizer --help | --version

COMMANDS
  optimize      tailor <cv-file> to a job; the job may be a file or a URL
  fetch-job     download a job posting to a text file
  pull-model    download the local embedding model ahead of the first run
  calibrate-vector  measure THRESHOLD_VECTOR for the configured embedding model
  check-filters  score one CV against one job with the chosen filters
  filters       list registered filters

OPTIONS
  -o, --out <path>        where to write the PDF        (default: ./output)
      --name <first last>  name used in the output filename
  -i, --instructions <s>  extra instructions for the optimizer
  -n, --max-iterations <n>  override MAX_ITERATIONS
      --seq               run filters sequentially, stop at first failure
      --dry-run           parse inputs and exit without calling any model

ENVIRONMENT
  PRO_MODEL, FLASH_MODEL, VISION_MODEL, EMBEDDING_MODEL, MAX_ITERATIONS, LOG_LEVEL,
  THRESHOLD_KEYWORD, THRESHOLD_VECTOR, THRESHOLD_HALLUCINATION,
  THRESHOLD_AI_GENERATED, THRESHOLD_VISION
`;

const main = async (argv: string[]): Promise<number> => {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' },
      name: { type: 'string' },
      instructions: { type: 'string', short: 'i' },
      'max-iterations': { type: 'string', short: 'n' },
      seq: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${version}\n`);
    return 0;
  }

  const [command, ...rest] = positionals;
  const config = loadConfig();

  switch (command) {
    case undefined:
      process.stdout.write(USAGE);
      return 1;

    case 'pull-model': {
      const { localEmbeddings } = await import('./providers/local-embeddings.ts');
      const provider = localEmbeddings(config);
      logger.info(`downloading embedding model ${config.embedding.model} ...`);
      try {
        await provider.prefetch();
        logger.info('model ready - cached locally, no network needed at run time');
        return 0;
      } finally {
        await provider.close();
      }
    }

    case 'fetch-job': {
      const [url, out] = rest;
      if (url === undefined || out === undefined) {
        logger.error('fetch-job needs <url> and <out-file>');
        return 1;
      }
      const { fetchJobToFile } = await import('./fetch-job.ts');
      const text = await fetchJobToFile(url, out);
      logger.info(`${text.length} chars written`);
      return 0;
    }

    case 'calibrate-vector': {
      const [cvPath, jdDir] = rest;
      if (cvPath === undefined || jdDir === undefined) {
        logger.error('calibrate-vector needs <cv-file> and a directory of job folders');
        return 1;
      }
      const { calibrateVector } = await import('./calibrate.ts');
      return await calibrateVector(cvPath, jdDir, config);
    }

    case 'check-filters': {
      const [cvPath, jdPath, names] = rest;
      if (cvPath === undefined || jdPath === undefined || names === undefined) {
        logger.error('check-filters needs <cv-file> <jd-file> <filter[,filter...]|all>');
        return 1;
      }
      const { checkFilters } = await import('./check-filters.ts');
      return await checkFilters(cvPath, jdPath, names, config);
    }

    case 'filters': {
      const { all } = await import('./filters/index.ts');
      const filters = all();
      if (filters.length === 0) {
        process.stdout.write('no filters registered yet\n');
        return 0;
      }
      for (const f of filters) process.stdout.write(`${f.priority}\t${f.name}\n`);
      return 0;
    }

    case 'optimize': {
      const [cvPath, jdPath] = rest;
      if (cvPath === undefined || jdPath === undefined) {
        logger.error('optimize needs both <cv-file> and <jd-file>');
        process.stdout.write(USAGE);
        return 1;
      }
      const rawMax = values['max-iterations'];
      const maxIterations = rawMax === undefined ? null : Number(rawMax);
      if (maxIterations !== null && !Number.isFinite(maxIterations)) {
        logger.error(`--max-iterations must be a number, got ${JSON.stringify(rawMax)}`);
        return 1;
      }
      const isUrl = /^https?:\/\//i.test(jdPath);
      const [cv, jd] = await Promise.all([
        readFile(cvPath, 'utf8'),
        isUrl
          ? import('./fetch-job.ts').then((m) => m.fetchJobText(jdPath))
          : readFile(jdPath, 'utf8'),
      ]);
      logger.info(`cv: ${cvPath} (${cv.length} chars)`);
      logger.info(`jd: ${jdPath} (${jd.length} chars${isUrl ? ', fetched' : ''})`);
      logger.info(`models: pro=${config.models.pro} flash=${config.models.flash}`);
      logger.info(`vision: ${config.models.vision}`);
      logger.info(`embeddings: ${config.embedding.model} (local, worker thread)`);

      if (values['dry-run']) {
        logger.info('dry run - inputs parsed, no model calls made');
        return 0;
      }

      const [
        { optimize },
        { generate },
        { playwrightRenderer },
        { aiSdkProviders },
        { localEmbeddings },
      ] = await Promise.all([
        import('./pipeline/orchestrator.ts'),
        import('./generator.ts'),
        import('./render/playwright.ts'),
        import('./providers/ai-sdk.ts'),
        import('./providers/local-embeddings.ts'),
      ]);
      await import('./filters/index.ts');

      const renderer = playwrightRenderer();
      const embeddings = localEmbeddings(config);
      const runConfig = maxIterations === null ? config : { ...config, maxIterations };

      try {
        const providers = aiSdkProviders(config.models);
        const { parseJobPosting } = await import('./job.ts');
        const job = await parseJobPosting(jd, providers.flash);
        const source = { text: cv, path: cvPath, instructions: values.instructions ?? null };

        const outcome = await optimize(source, job, {
          generate: (i) => generate(i, { renderer, config: runConfig }),
          renderer,
          chat: providers,
          embeddings,
          config: runConfig,
          sequential: values.seq === true,
        });

        const outDir = values.out ?? 'output';
        await mkdir(outDir, { recursive: true });
        const { runId, pdfPath, debugDirPath } = await import('./output-path.ts');
        const id = runId();
        const [first, ...restName] = (values.name ?? '').trim().split(/\s+/).filter(Boolean);
        const target = pdfPath(outDir, {
          firstName: first ?? null,
          lastName: restName.length > 0 ? restName.join(' ') : null,
          company: job.company || 'unknown',
          role: job.title || null,
          langCode: job.language,
          runId: id,
        });
        const rendered = await renderer.render(outcome.filed.resume.html);
        await writeFile(target, rendered.pdf);

        // One file per iteration, as hr-breaker's debug folder does. When a run
        // fails, this is what you look through to pick an attempt by hand.
        if (outcome.iterations.length > 1) {
          const dbg = debugDirPath(outDir, job.company || 'unknown', job.title || null, id);
          await mkdir(dbg, { recursive: true });
          for (const it of outcome.iterations) {
            if (it.resume.html === '') continue;
            const r = await renderer.render(it.resume.html);
            await writeFile(join(dbg, `iteration_${it.n}.pdf`), r.pdf);
            await writeFile(join(dbg, `iteration_${it.n}.png`), r.pngPage1);
          }
          logger.info(`debug: ${dbg} (${outcome.iterations.length} iterations)`);
        }

        logger.info(`iterations: ${outcome.iterations.length}`);
        logger.info(`pdf: ${target} (${rendered.pageCount} page(s))`);
        if (outcome.passed) {
          logger.info('PASSED - every filter agreed');
          return 0;
        }
        // A PDF exists either way. Never read a file's existence as success.
        logger.error(`FAILED filters: ${outcome.failedFilters.join(', ')}`);
        for (const r of outcome.filed.results.filter((x) => !x.passed)) {
          for (const issue of r.issues) logger.error(`  ${r.filterName}: ${issue}`);
        }
        return 2;
      } finally {
        await Promise.all([renderer.close(), embeddings.close()]);
      }
    }

    default:
      logger.error(`unknown command: ${command}`);
      process.stdout.write(USAGE);
      return 1;
  }
};

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
