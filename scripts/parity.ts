/**
 * Runs cv-optimizer and hr-breaker over the same job descriptions and records
 * what each one scored.
 *
 * Results are appended to `docs/parity-results.json` and a readable table is
 * written to `docs/parity-report.md`. Both are committed, so the numbers stay
 * available without re-running anything.
 *
 * The script is RESUMABLE. A job already in the results file is skipped, so a
 * run that is interrupted, or a run for one more job, costs only what is
 * missing. Pass --force to redo everything.
 *
 * Usage:
 *   node scripts/parity.ts [--only <substring>] [--concurrency N] [--force]
 *                          [--skip-python]
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import process from 'node:process';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const CVOPT = join(ROOT, 'cv-optimizer');
const HRB = join(ROOT, 'hr-breaker');
const APPS = join(ROOT, 'applications');
const RESULTS = join(CVOPT, 'docs/parity-results.json');
const REPORT = join(CVOPT, 'docs/parity-report.md');
// Generated CVs land here so they can be opened after the run. Gitignored.
const OUT = join(CVOPT, 'output/parity');

const INSTRUCTIONS =
  'use same structure for the Contact info EXACTLY as in the source - 2 lines: 1st line ONLY ' +
  'for email/web, second line ONLY for phones, same separator, NEVER allow phones to cling to ' +
  "1st line; never remove phones; do not change '15+ years'; do not remove jobs; NEVER add " +
  "anything that isn't in the source; NEVER use FUCKEN EM-DASH!; 2 pages are OK";

interface Scores {
  [filter: string]: { score: number; threshold: number; passed: boolean };
}
interface Side {
  ok: boolean;
  iterations: number | null;
  scores: Scores;
  error?: string;
  seconds: number;
}
interface Row {
  job: string;
  ts: Side;
  py: Side | null;
  when: string;
}

/**
 * No env handling here on purpose.
 *
 * Each tool loads its own `.env`: cv-optimizer in `config.ts`, hr-breaker with
 * python-dotenv. An earlier version of this script scraped hr-breaker's `.env`
 * with `require()`, which does not exist in an ESM module. The call threw, a
 * `catch` swallowed it, and every cv-optimizer run started with no API key and
 * died in under a second - reported as a normal `fail`. Do not reintroduce it.
 */

const run = (
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ out: string; code: number; seconds: number }> =>
  new Promise((resolve) => {
    const t0 = Date.now();
    execFile(
      cmd,
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024, timeout: 45 * 60 * 1000 },
      (err, stdout, stderr) => {
        resolve({
          out: `${stdout}\n${stderr}`,
          code: err === null ? 0 : ((err as { code?: number }).code ?? 1),
          seconds: Math.round((Date.now() - t0) / 10) / 100,
        });
      },
    );
  });

/** Both tools log one line of `Name:score/threshold` pairs per iteration. */
const parseScores = (text: string): { scores: Scores; iterations: number } => {
  const scores: Scores = {};
  let iterations = 0;
  for (const line of text.split('\n')) {
    const pairs = [...line.matchAll(/([A-Za-z]+):(-|[\d.]+)\/([\d.]+)([+\-✓✗])/g)];
    if (pairs.length < 3) continue;
    iterations++;
    for (const p of pairs) {
      const name = p[1] as string;
      scores[name] = {
        score: p[2] === '-' ? Number.NaN : Number(p[2]),
        threshold: Number(p[3]),
        passed: p[4] === '+' || p[4] === '✓',
      };
    }
  }
  return { scores, iterations };
};

/**
 * A run that produced no score line did not really run. Say so loudly and
 * distinctly, so it can never be mistaken for a filter verdict.
 *
 * The 0.4-second "failures" that made the first parity attempt worthless all
 * looked exactly like ordinary failures in the table.
 */
const classify = (side: Side, label: string, job: string, tail: string): Side => {
  const nFilters = Object.keys(side.scores).length;
  if (nFilters === 0) {
    process.stdout.write(
      `\n  !! ${label} produced NO SCORES for ${job} after ${side.seconds}s.\n` +
        `     This is not a filter result. The run did not work.\n` +
        `     last output: ${tail}\n\n`,
    );
    return { ...side, ok: false, error: `NO SCORES after ${side.seconds}s: ${tail}` };
  }
  if (side.seconds < 5) {
    process.stdout.write(
      `\n  !! ${label} finished ${job} in ${side.seconds}s. That is too fast to be real.\n\n`,
    );
  }
  return side;
};

const runTs = async (jd: string, outDir: string): Promise<Side> => {
  const r = await run(
    'node',
    [
      'src/cli.ts',
      'optimize',
      join(ROOT, 'cv.md'),
      jd,
      '-o',
      outDir,
      '-n',
      '3',
      '-i',
      INSTRUCTIONS,
    ],
    CVOPT,
  );
  const { scores, iterations } = parseScores(r.out);
  const tail = r.out.split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 300);
  return classify(
    {
      ok: r.code === 0,
      iterations,
      scores,
      seconds: r.seconds,
      ...(r.code === 0 ? {} : { error: tail }),
    },
    'cv-optimizer',
    jd.split('/').slice(-2)[0] ?? jd,
    tail,
  );
};

const runPy = async (jd: string): Promise<Side> => {
  const r = await run(
    'uv',
    ['run', 'hr-breaker', 'optimize', join(ROOT, 'cv.md'), jd, '-i', INSTRUCTIONS],
    HRB,
  );
  const { scores, iterations } = parseScores(r.out);
  const tail = r.out.split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 300);
  return classify(
    { ok: /Iteration \d+: PASS/.test(r.out), iterations, scores, seconds: r.seconds },
    'hr-breaker',
    jd.split('/').slice(-2)[0] ?? jd,
    tail,
  );
};

const fmt = (s: { score: number; threshold: number; passed: boolean } | undefined): string =>
  s === undefined
    ? '-'
    : `${Number.isNaN(s.score) ? 'skip' : s.score.toFixed(2)}${s.passed ? '' : ' FAIL'}`;

const writeReport = async (rows: Row[]): Promise<void> => {
  const names = [
    'ContentLengthChecker',
    'DataValidator',
    'HallucinationChecker',
    'KeywordMatcher',
    'VisionChecker',
    'LLMChecker',
    'VectorSimilarityMatcher',
    'AiGeneratedChecker',
    'AIGeneratedChecker',
  ];
  const used = names.filter((n) => rows.some((r) => r.ts.scores[n] ?? r.py?.scores[n]));

  const lines: string[] = [
    '# Parity report: cv-optimizer vs hr-breaker',
    '',
    'Generated by `node scripts/parity.ts`. Both tools run over the same job',
    'descriptions, the same `cv.md` and the same `-i` instructions.',
    '',
    `Last updated: ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    '',
    '## Outcome',
    '',
    '| job | cv-optimizer | hr-breaker | ts iters | py iters | ts secs | py secs |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.job.slice(0, 42)} | ${r.ts.ok ? 'PASS' : 'fail'} | ` +
        `${r.py === null ? 'not run' : r.py.ok ? 'PASS' : 'fail'} | ` +
        `${r.ts.iterations ?? '-'} | ${r.py?.iterations ?? '-'} | ` +
        `${r.ts.seconds} | ${r.py?.seconds ?? '-'} |`,
    );
  }

  lines.push('', '## Scores, final iteration', '');
  lines.push(`| job | tool | ${used.join(' | ')} |`);
  lines.push(`| --- | --- | ${used.map(() => '---').join(' | ')} |`);
  for (const r of rows) {
    lines.push(
      `| ${r.job.slice(0, 30)} | ts | ${used.map((n) => fmt(r.ts.scores[n])).join(' | ')} |`,
    );
    if (r.py !== null) {
      lines.push(`| | py | ${used.map((n) => fmt(r.py?.scores[n])).join(' | ')} |`);
    }
  }

  const tsPass = rows.filter((r) => r.ts.ok).length;
  const pyRows = rows.filter((r) => r.py !== null);
  const pyPass = pyRows.filter((r) => r.py?.ok === true).length;
  lines.push(
    '',
    '## Summary',
    '',
    `- cv-optimizer passed ${tsPass} of ${rows.length}`,
    `- hr-breaker passed ${pyPass} of ${pyRows.length}`,
    '',
    'Note: hr-breaker runs its vision filter on its configured flash model,',
    'which is DeepSeek. DeepSeek cannot accept images, so its LLMChecker scores',
    'come from text alone. See porting-notes section 8.',
    '',
  );
  await writeFile(REPORT, lines.join('\n'), 'utf8');
};

const main = async (): Promise<number> => {
  const { values } = parseArgs({
    options: {
      only: { type: 'string' },
      concurrency: { type: 'string', default: '2' },
      force: { type: 'boolean', default: false },
      'skip-python': { type: 'boolean', default: false },
    },
  });

  const dirs = (await readdir(APPS, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((n) => existsSync(join(APPS, n, 'jd.txt')))
    .filter((n) => (values.only === undefined ? true : n.includes(values.only)))
    .sort();

  let rows: Row[] = [];
  if (!values.force && existsSync(RESULTS)) {
    rows = JSON.parse(await readFile(RESULTS, 'utf8')) as Row[];
  }

  /**
   * Resume PER SIDE, not per job.
   *
   * A side counts as done only if it produced scores. A recorded run with no
   * scores did not work, so it is re-run rather than trusted. That is what
   * turned a broken first attempt into four rows of useless "fail".
   */
  const hasScores = (side: Side | null | undefined): boolean =>
    side !== null && side !== undefined && Object.keys(side.scores).length > 0;

  const byJob = new Map(rows.map((r) => [r.job, r]));
  const todo = dirs.filter((d) => {
    const prev = byJob.get(d);
    const needTs = !hasScores(prev?.ts);
    const needPy = values['skip-python'] === true ? false : !hasScores(prev?.py);
    return needTs || needPy;
  });

  process.stdout.write(`${dirs.length} jobs total, ${todo.length} need work\n`);
  for (const d of dirs) {
    const prev = byJob.get(d);
    process.stdout.write(
      `  ${d.slice(0, 46).padEnd(46)} ts=${hasScores(prev?.ts) ? 'have' : 'NEED'}` +
        ` py=${hasScores(prev?.py) ? 'have' : values['skip-python'] === true ? 'skip' : 'NEED'}\n`,
    );
  }
  await mkdir(join(CVOPT, 'docs'), { recursive: true });
  await mkdir(OUT, { recursive: true });

  const limit = Math.max(1, Number(values.concurrency));
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      const job = todo[i];
      if (job === undefined) return;
      const jd = join(APPS, job, 'jd.txt');
      const prev = byJob.get(job);
      process.stdout.write(`  start ${job}\n`);

      // Keep a side that already produced scores. Only re-run what is missing.
      const ts = hasScores(prev?.ts) ? (prev?.ts as Side) : await runTs(jd, OUT);
      const py = hasScores(prev?.py)
        ? (prev?.py as Side)
        : values['skip-python'] === true
          ? (prev?.py ?? null)
          : await runPy(jd);

      rows = rows.filter((r) => r.job !== job);
      rows.push({ job, ts, py, when: new Date().toISOString() });
      rows.sort((a, b) => a.job.localeCompare(b.job));
      await writeFile(RESULTS, JSON.stringify(rows, null, 1), 'utf8');
      await writeReport(rows);
      process.stdout.write(
        `  done  ${job}: ts=${ts.ok ? 'PASS' : 'fail'} (${ts.seconds}s)` +
          `${py === null ? '' : ` py=${py.ok ? 'PASS' : 'fail'} (${py.seconds}s)`}\n`,
      );
    }
  };
  await Promise.all(Array.from({ length: limit }, () => worker()));

  await writeReport(rows);
  process.stdout.write(`\nwrote ${REPORT}\n`);
  process.stdout.write(`generated CVs are in ${OUT}\n`);
  return 0;
};

process.exitCode = await main();
