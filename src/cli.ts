#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { loadConfig } from './config.ts';
import { logger } from './logger.ts';
import { version } from './version.ts';

const USAGE = `cv-optimizer - tailor a CV to a job description

USAGE
  cv-optimizer optimize <cv-file> <jd-file> [options]
  cv-optimizer pull-model
  cv-optimizer calibrate-vector <cv-file> <jd-glob-dir>
  cv-optimizer check-filters <cv-file> <jd-file> <filter[,filter...]|all>
  cv-optimizer filters
  cv-optimizer --help | --version

COMMANDS
  optimize      tailor <cv-file> to <jd-file>
  pull-model    download the local embedding model ahead of the first run
  calibrate-vector  measure THRESHOLD_VECTOR for the configured embedding model
  check-filters  score one CV against one job with the chosen filters
  filters       list registered filters

OPTIONS
  -o, --out <path>        where to write the PDF        (default: ./output)
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
      const [cv, jd] = await Promise.all([readFile(cvPath, 'utf8'), readFile(jdPath, 'utf8')]);
      logger.info(`cv: ${cvPath} (${cv.length} chars)`);
      logger.info(`jd: ${jdPath} (${jd.length} chars)`);
      logger.info(`models: pro=${config.models.pro} flash=${config.models.flash}`);
      logger.info(`vision: ${config.models.vision}`);
      logger.info(`embeddings: ${config.embedding.model} (local, worker thread)`);

      if (values['dry-run']) {
        logger.info('dry run - inputs parsed, no model calls made');
        return 0;
      }

      logger.error('pipeline not wired up yet - see docs/architecture.md');
      return 2;
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
