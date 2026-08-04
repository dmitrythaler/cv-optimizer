import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { logger } from './logger.ts';
import { cosine } from './providers/embeddings.ts';
import { localEmbeddings } from './providers/local-embeddings.ts';
import type { Config } from './config.ts';

/**
 * Measures THRESHOLD_VECTOR for whichever embedding model is configured.
 *
 * A cosine threshold is only meaningful for the model that produced the
 * numbers. hr-breaker's 0.55 was measured against hosted gemini-embedding-001;
 * carrying it to a different model would be a guess dressed as a measurement.
 * This command exists so the measurement is repeatable rather than folklore.
 *
 * Method: embed the real corpus, embed a deliberately off-topic control, and
 * check the two form separate clusters. If they do not, the filter is not
 * measuring anything useful and no threshold will rescue it.
 */

/** Off-topic text. If this scores near the real jobs, the filter is worthless. */
const CONTROLS: Record<string, string> = {
  'bread recipe':
    'Recipe for sourdough bread: flour, water, salt, starter. Mix, autolyse for one hour, ' +
    'bulk ferment, shape, proof overnight, bake at 230C for 40 minutes in a dutch oven.',
  'wrong stack (Java)':
    'Senior Java Engineer. Required: Java 21, Spring Boot, Hibernate, Maven, JVM tuning, ' +
    'Kafka Streams, Oracle PL/SQL. Enterprise banking platform.',
};

export const calibrateVector = async (
  cvPath: string,
  jdDir: string,
  config: Config,
): Promise<number> => {
  const cv = await readFile(cvPath, 'utf8');

  const entries = await readdir(jdDir, { withFileTypes: true });
  const jobs: { name: string; text: string }[] = [];
  for (const e of entries.filter((x) => x.isDirectory())) {
    try {
      jobs.push({ name: e.name, text: await readFile(join(jdDir, e.name, 'jd.txt'), 'utf8') });
    } catch {
      // A folder without a jd.txt is not a job; skip it quietly.
    }
  }
  if (jobs.length === 0) {
    logger.error(`no */jd.txt found under ${jdDir}`);
    return 1;
  }

  const embeddings = localEmbeddings(config);
  try {
    logger.info(`model ${config.embedding.model} - embedding ${jobs.length} jobs + controls`);
    const dims = await embeddings.dimensions();

    const controlNames = Object.keys(CONTROLS);
    const texts = [cv, ...jobs.map((j) => j.text), ...controlNames.map((k) => CONTROLS[k] ?? '')];
    const vectors = await embeddings.embed(texts);

    const cvVec = vectors[0];
    if (cvVec === undefined) throw new Error('no CV vector returned');

    const score = (i: number): number => {
      const v = vectors[i];
      if (v === undefined) throw new Error(`missing vector ${i}`);
      return cosine(cvVec, v);
    };

    const real = jobs.map((j, i) => ({ name: j.name, cos: score(1 + i) }));
    const control = controlNames.map((n, i) => ({ name: n, cos: score(1 + jobs.length + i) }));

    const out = process.stdout;
    out.write(`\nembedding model : ${config.embedding.model}\n`);
    out.write(`dimensions      : ${dims}\n\n`);
    out.write('REAL JOBS (should cluster high)\n');
    for (const r of [...real].sort((a, b) => a.cos - b.cos)) {
      out.write(`  ${r.cos.toFixed(4)}  ${r.name.slice(0, 60)}\n`);
    }
    out.write('\nCONTROLS (should sit clearly below)\n');
    for (const c of control) out.write(`  ${c.cos.toFixed(4)}  ${c.name}\n`);

    const lo = Math.min(...real.map((r) => r.cos));
    const hi = Math.max(...control.map((c) => c.cos));
    const gap = lo - hi;

    out.write(`\nlowest real job : ${lo.toFixed(4)}\n`);
    out.write(`highest control : ${hi.toFixed(4)}\n`);
    out.write(`separation      : ${gap.toFixed(4)}\n`);

    if (gap <= 0) {
      out.write(
        '\nNO SEPARATION. The controls score as high as the real jobs, so this\n' +
          'filter cannot distinguish them at whole-document granularity. Do not\n' +
          'pick a threshold - fix the approach (chunked embedding) or drop the filter.\n',
      );
      return 1;
    }

    const suggested = Math.round((hi + gap / 2) * 100) / 100;
    out.write(`\nSUGGESTED THRESHOLD_VECTOR=${suggested}  (midpoint of the gap)\n`);
    out.write('Record this measurement in docs/porting-notes.md alongside the model name.\n\n');
    return 0;
  } finally {
    await embeddings.close();
  }
};
