import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareRun, writeRun } from '../src/run-output.ts';
import { loadConfig } from '../src/config.ts';
import { logger } from '../src/logger.ts';
import type { Renderer } from '../src/render/pdf.ts';
import type { FilterResult, Iteration, JobPosting, OptimizationOutcome } from '../src/types.ts';

/**
 * These cover the branches a live run rarely reaches. Both verification runs
 * passed on iteration 1, so nothing exercised errors.log or an unrenderable
 * filed iteration - exactly the paths that matter when something goes wrong.
 */

const fakeRenderer = (fail = false): Renderer => ({
  render: (markdown: string) =>
    fail
      ? Promise.reject(new Error('render exploded'))
      : Promise.resolve({
          pdf: new Uint8Array([1, 2, 3, markdown.length]),
          text: 'text',
          pngPage1: new Uint8Array([9, 9]),
          pageCount: 2,
          pageTexts: ['a', 'b'],
        }),
  close: () => Promise.resolve(),
});

const result = (name: string, passed: boolean): FilterResult => ({
  filterName: name,
  passed,
  score: passed ? 0.9 : 0.4,
  threshold: 0.7,
  issues: passed ? [] : [`${name} is unhappy`],
  suggestions: passed ? [] : ['try harder'],
});

const iteration = (
  n: number,
  passed: boolean,
  markdown = '::: {.summary}\ncv\n:::',
): Iteration => ({
  n,
  resume: { markdown, pdfText: 'text', pngPage1: null, pageCount: 2, pageTexts: null },
  results: [result('KeywordMatcher', true), result('AtsChecker', passed)],
  passed,
});

const outcomeOf = (iterations: Iteration[]): OptimizationOutcome => {
  const filed = iterations[iterations.length - 1] as Iteration;
  return {
    iterations,
    filed,
    passed: filed.passed,
    failedFilters: filed.results.filter((r) => !r.passed).map((r) => r.filterName),
  };
};

const JOB: JobPosting = {
  title: 'Full-Stack Engineer',
  company: 'Beacon Group',
  description: 'd',
  rawText: 'raw',
  requirements: ['React'],
  keywords: ['React'],
  language: 'en',
};

const SOURCE = { text: 'cv text', path: 'templates/example.cv.md', instructions: null };

const JD = 'Full-Stack Engineer at Beacon Group. React, Node.js, PostgreSQL.';
const JOB_SOURCE = {
  from: 'https://example.test/job',
  kind: 'url' as const,
  method: 'request' as const,
};

const write = async (
  outcome: OptimizationOutcome,
  opts: { renderFails?: boolean; template?: string } = {},
): Promise<{ dir: string; folder: string; files: string[] }> => {
  const dir = await mkdtemp(join(tmpdir(), 'cvopt-'));
  const base = loadConfig();
  const config = { ...base, cvNameTemplate: opts.template ?? 'CV.{company}.{position}.pdf' };
  // No -o here, so the run gets its own stamped folder under `dir`.
  const prepared = await prepareRun(dir, JOB, config);
  // The CLI writes jd.txt immediately after prepareRun and before the loop, so
  // a run that dies mid-way keeps the posting. This mirrors that order.
  await writeFile(join(prepared.folder, 'jd.txt'), `${JD}\n`, 'utf8');
  const { folder } = await writeRun({
    prepared,
    outcome,
    job: JOB,
    source: SOURCE,
    renderer: fakeRenderer(opts.renderFails ?? false),
    config,
    startedAt: Date.now() - 1000,
    jobSource: JOB_SOURCE,
  });
  return { dir, folder, files: (await readdir(folder)).sort() };
};

test('run folder: a passing run writes no errors.log', async () => {
  logger.resetProblems();
  const { files } = await write(outcomeOf([iteration(1, true)]));
  assert.deepEqual(files, [
    'CV.beacon_group.full_stack_engineer.pdf',
    'iteration_1.pdf',
    'iteration_1.png',
    'jd.txt',
    'optimization.json',
  ]);
});

test('run folder: keeps every iteration, not only the filed one', async () => {
  logger.resetProblems();
  const { files } = await write(
    outcomeOf([iteration(1, false), iteration(2, false), iteration(3, true)]),
  );
  for (const n of [1, 2, 3]) {
    assert.ok(files.includes(`iteration_${n}.pdf`), `iteration_${n}.pdf kept`);
    assert.ok(files.includes(`iteration_${n}.png`), `iteration_${n}.png kept`);
  }
});

test('run folder: a failing run records the issues in errors.log', async () => {
  logger.resetProblems();
  logger.error('FAILED filters: AtsChecker');
  logger.error('  AtsChecker: AtsChecker is unhappy');

  const { folder, files } = await write(outcomeOf([iteration(1, false)]));
  assert.ok(files.includes('errors.log'), 'errors.log written');

  const log = await readFile(join(folder, 'errors.log'), 'utf8');
  assert.match(log, /FAILED filters: AtsChecker/);
  assert.match(log, /AtsChecker is unhappy/);
});

test('optimization.json: records the verdict and every filter score', async () => {
  logger.resetProblems();
  const { folder } = await write(outcomeOf([iteration(1, false), iteration(2, true)]));
  const j = JSON.parse(await readFile(join(folder, 'optimization.json'), 'utf8')) as {
    passed: boolean;
    filedIteration: number;
    cvFile: string;
    failedFilters: string[];
    iterations: { n: number; passed: boolean; filters: { name: string; score: number }[] }[];
  };

  assert.equal(j.passed, true);
  assert.equal(j.filedIteration, 2);
  assert.equal(j.cvFile, 'CV.beacon_group.full_stack_engineer.pdf');
  assert.deepEqual(j.failedFilters, []);
  assert.equal(j.iterations.length, 2);
  assert.equal(j.iterations[0]?.passed, false);
  assert.deepEqual(
    j.iterations[0]?.filters.map((f) => f.name),
    ['KeywordMatcher', 'AtsChecker'],
  );
});

test('run folder: no CV file when the filed iteration cannot render', async () => {
  logger.resetProblems();
  const { folder, files } = await write(outcomeOf([iteration(1, false)]), { renderFails: true });

  // An empty or absent PDF is honest. A zero-byte file that looks like a result
  // is not - see design rule 6, a produced PDF is never proof of a pass.
  assert.ok(!files.includes('CV.beacon_group.full_stack_engineer.pdf'), 'no CV written');
  assert.ok(files.includes('errors.log'), 'and it says why');

  const j = JSON.parse(await readFile(join(folder, 'optimization.json'), 'utf8')) as {
    cvFile: string | null;
  };
  assert.equal(j.cvFile, null);
});

test('run folder: an unknown placeholder stops the run before anything is written', async () => {
  logger.resetProblems();
  const dir = await mkdtemp(join(tmpdir(), 'cvopt-'));
  const config = { ...loadConfig(), cvNameTemplate: 'CV.{compnay}.pdf' };
  await assert.rejects(prepareRun(dir, JOB, config), /unknown placeholder/i);
  // Not even an empty folder: the name is resolved before anything is created.
  assert.deepEqual(await readdir(dir), []);
});

/**
 * The run folder, and why these two cases differ.
 *
 * `prepareRun` once returned `--out` unchanged, so NO stamped folder was ever
 * created and a second run overwrote the first one's jd.txt, optimization.json
 * and every iteration. Nothing caught it, because the batch runner passes a
 * fresh `-o` per job, so every run already had a folder of its own. These two
 * tests pin both halves of the contract down.
 */
test('prepareRun: with no -o the run gets its own stamped folder', async () => {
  logger.resetProblems();
  const dir = await mkdtemp(join(tmpdir(), 'cvopt-'));
  const { folder } = await prepareRun(dir, JOB, loadConfig());

  assert.notEqual(folder, dir, 'a subfolder, not the parent');
  assert.match(
    folder,
    /\/\d{8}-\d{4}-beacon_group-full_stack_engineer$/,
    '{date}-{time}-{company}-{position}',
  );
  // Empty. prepareRun creates the folder; the caller fills it.
  assert.deepEqual(await readdir(folder), []);
});

test('prepareRun: with -o that exact folder is used, with no second level', async () => {
  logger.resetProblems();
  const dir = await mkdtemp(join(tmpdir(), 'cvopt-'));
  const { folder } = await prepareRun(dir, JOB, loadConfig(), true);

  assert.equal(folder, dir, 'verbatim');
  assert.deepEqual(await readdir(dir), [], 'no stamped folder inside it');
});

test('optimization.json: records where the posting came from', async () => {
  logger.resetProblems();
  const { folder } = await write(outcomeOf([iteration(1, true)]));
  const j = JSON.parse(await readFile(join(folder, 'optimization.json'), 'utf8')) as {
    job: { source: { from: string; kind: string; method: string } };
  };
  // `job.file` is not recorded and must not be asserted: the posting is always
  // `jd.txt` in the run folder, so the name carries no information. What the
  // report has to answer is where that text CAME from.
  assert.equal(j.job.source.kind, 'url');
  assert.equal(j.job.source.from, 'https://example.test/job');
  assert.equal(j.job.source.method, 'request');
});
