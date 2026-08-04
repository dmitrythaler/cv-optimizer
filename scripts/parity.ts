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

const INSTRUCTIONS =
  "use same structure for the Contact info EXACTLY as in the source - 2 lines: 1st line ONLY " +
  "for email/web, second line ONLY for phones, same separator, NEVER allow phones to cling to " +
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

const env = (): NodeJS.ProcessEnv => {
  const dotenv = readFileSyncSafe(join(HRB, '.env'));
  const out: NodeJS.ProcessEnv = { ...process.env };
  for (const line of dotenv.split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m?.[1] !== undefined && m[2] !== undefined) out[m[1]] ??= m[2];
  }
  out['THRESHOLD_VECTOR'] ??= '0.67';
  return out;
};

function readFileSyncSafe(p: string): string {
  try {
    // eslint-disable-next-line
    return require('node:fs').readFileSync(p, 'utf8') as string;
  } catch {
    return '';
  }
}

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
      { cwd, env: env(), maxBuffer: 64 * 1024 * 1024, timeout: 45 * 60 * 1000 },
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
      '--name',
      'Dmitry Thaler',
      '-i',
      INSTRUCTIONS,
    ],
    CVOPT,
  );
  const { scores, iterations } = parseScores(r.out);
  return {
    ok: r.code === 0,
    iterations,
    scores,
    seconds: r.seconds,
    ...(r.code === 0 ? {} : { error: r.out.split('\n').filter(Boolean).slice(-3).join(' | ') }),
  };
};

const runPy = async (jd: string): Promise<Side> => {
  const r = await run('uv', ['run', 'hr-breaker', 'optimize', join(ROOT, 'cv.md'), jd, '-i', INSTRUCTIONS], HRB);
  const { scores, iterations } = parseScores(r.out);
  return {
    ok: /Iteration \d+: PASS/.test(r.out),
    iterations,
    scores,
    seconds: r.seconds,
    ...(scores && Object.keys(scores).length > 0
      ? {}
      : { error: r.out.split('\n').filter(Boolean).slice(-3).join(' | ') }),
  };
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
    lines.push(`| ${r.job.slice(0, 30)} | ts | ${used.map((n) => fmt(r.ts.scores[n])).join(' | ')} |`);
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
  const done = new Set(rows.map((r) => r.job));
  const todo = dirs.filter((d) => !done.has(d));

  process.stdout.write(`${dirs.length} jobs, ${todo.length} to run\n`);
  await mkdir(join(CVOPT, 'docs'), { recursive: true });

  const limit = Math.max(1, Number(values.concurrency));
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      const job = todo[i];
      if (job === undefined) return;
      const jd = join(APPS, job, 'jd.txt');
      process.stdout.write(`  start ${job}\n`);
      const ts = await runTs(jd, '/tmp/parity-out');
      const py = values['skip-python'] === true ? null : await runPy(jd);
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
  return 0;
};

process.exitCode = await main();
