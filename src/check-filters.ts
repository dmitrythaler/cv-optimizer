import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { logger } from './logger.ts';
import { all } from './filters/index.ts';
import { aiSdkProviders } from './providers/ai-sdk.ts';
import { localEmbeddings } from './providers/local-embeddings.ts';
import type { Config } from './config.ts';
import type { Filter, FilterContext } from './filters/base.ts';
import type { FilterResult } from './types.ts';

/**
 * Runs chosen filters against a CV file and a job file, and prints the scores.
 *
 * This is a diagnostic tool. Use it to tune a threshold, or to check that a
 * filter works, without a full optimize run.
 *
 * LIMIT: a filter grades a RENDERED CV. The renderer does not exist yet. This
 * command therefore puts the file text into both `html` and `pdfText`, and
 * leaves the page count and the page image empty. So:
 *   - KeywordMatcher, VectorSimilarityMatcher and AiGeneratedChecker work.
 *   - HallucinationChecker works, but it compares the file with itself, so it
 *     always reports no fabrication.
 *   - ContentLengthChecker passes without a test, because there are no pages.
 *   - DataValidator wants resume HTML. A markdown file fails it.
 *   - VisionChecker needs a page image and reports that it has none.
 * The output marks each of these cases.
 */

/** Notes which filters cannot give a real answer without a rendered CV. */
const CAVEATS: Record<string, string> = {
  ContentLengthChecker: 'no rendered pages, so it passes without a test',
  DataValidator: 'expects resume HTML; a markdown file will fail',
  HallucinationChecker: 'compares the file with itself; expect a perfect score',
  VisionChecker: 'needs a rendered page image, which this command cannot make',
};

const pick = (names: string): { chosen: Filter[]; unknown: string[] } => {
  const registry = all();
  if (names.trim() === 'all') return { chosen: [...registry], unknown: [] };

  const wanted = names
    .split(',')
    .map((n) => n.trim())
    .filter((n) => n.length > 0);

  const chosen: Filter[] = [];
  const unknown: string[] = [];
  for (const w of wanted) {
    const found = registry.find((f) => f.name.toLowerCase() === w.toLowerCase());
    if (found === undefined) unknown.push(w);
    else if (!chosen.includes(found)) chosen.push(found);
  }
  chosen.sort((a, b) => a.priority - b.priority);
  return { chosen, unknown };
};

const verdict = (r: FilterResult): string => {
  if (Number.isNaN(r.score)) return 'SKIP';
  return r.passed ? 'pass' : 'FAIL';
};

const num = (v: number): string => (Number.isNaN(v) ? '   -  ' : v.toFixed(4));

export const checkFilters = async (
  cvPath: string,
  jdPath: string,
  names: string,
  config: Config,
): Promise<number> => {
  const registry = all();
  const { chosen, unknown } = pick(names);

  if (unknown.length > 0) {
    logger.error(`unknown filter(s): ${unknown.join(', ')}`);
    logger.error(`known: ${registry.map((f) => f.name).join(', ')}, or "all"`);
    return 1;
  }
  if (chosen.length === 0) {
    logger.error('no filters chosen');
    return 1;
  }

  const [cv, jd] = await Promise.all([readFile(cvPath, 'utf8'), readFile(jdPath, 'utf8')]);

  const embeddings = localEmbeddings(config);
  try {
    const ctx: FilterContext = {
      resume: {
        html: cv,
        pdfText: cv,
        pngPage1: null,
        pageCount: null,
        pageTexts: null,
      },
      // There is no job parser yet, so the whole file is the description.
      // KeywordMatcher and VectorSimilarityMatcher join title, description and
      // requirements, so a description alone is enough for them.
      job: {
        title: '',
        company: '',
        description: jd,
        rawText: jd,
        requirements: [],
        keywords: [],
        language: 'en',
      },
      source: { text: cv, path: cvPath, instructions: null },
      config,
      chat: aiSdkProviders(config.models),
      embeddings,
      targetLanguage: 'en',
    };

    const out = process.stdout;
    out.write(`\ncv  : ${cvPath} (${cv.length} chars)\n`);
    out.write(`jd  : ${jdPath} (${jd.length} chars)\n`);
    out.write(`pro : ${config.models.pro}\n`);
    out.write(`fls : ${config.models.flash}\n`);
    out.write(`vis : ${config.models.vision}\n`);
    out.write(`emb : ${config.embedding.model}\n\n`);
    out.write(`${'filter'.padEnd(26)} ${'score'.padEnd(7)} ${'thresh'.padEnd(7)} result\n`);
    out.write(`${'-'.repeat(26)} ${'-'.repeat(7)} ${'-'.repeat(7)} ------\n`);

    let failures = 0;
    const details: string[] = [];

    for (const f of chosen) {
      try {
        const r = await f.evaluate(ctx);
        if (!r.passed) failures++;
        out.write(
          `${f.name.padEnd(26)} ${num(r.score).padEnd(7)} ${num(r.threshold).padEnd(7)} ${verdict(r)}\n`,
        );
        for (const i of r.issues) details.push(`  ${f.name}: ${i}`);
        for (const s of r.suggestions) details.push(`  ${f.name}: -> ${s}`);
      } catch (err: unknown) {
        failures++;
        const msg = err instanceof Error ? err.message : String(err);
        out.write(`${f.name.padEnd(26)} ${'-'.padEnd(7)} ${'-'.padEnd(7)} ERROR\n`);
        details.push(`  ${f.name}: ${msg}`);
      }
    }

    if (details.length > 0) {
      out.write('\nissues and suggestions\n');
      for (const d of details) out.write(`${d}\n`);
    }

    const noted = chosen.filter((f) => CAVEATS[f.name] !== undefined);
    if (noted.length > 0) {
      out.write('\nnote: these filters need a rendered CV, which does not exist yet\n');
      for (const f of noted) out.write(`  ${f.name}: ${CAVEATS[f.name] ?? ''}\n`);
    }

    out.write('\n');
    return failures > 0 ? 2 : 0;
  } finally {
    await embeddings.close();
  }
};
