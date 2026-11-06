import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkKeywords } from '../src/filters/keyword-matcher.ts';
import { keywordMatcher } from '../src/filters/keyword-matcher.ts';
import { loadConfig } from '../src/config.ts';
import type { JobPosting } from '../src/types.ts';
import type { FilterContext } from '../src/filters/base.ts';
import type { EmbeddingProvider } from '../src/providers/embeddings.ts';
import type { ChatProviders } from '../src/providers/ai-sdk.ts';
import type { ChatProvider } from '../src/providers/llm.ts';

interface Case {
  jd?: string;
  title?: string;
  description?: string;
  requirements?: string[];
  keywords?: string[];
  score: number;
  passed: boolean;
  missing: string[];
}
const fixtures: Record<string, Case> = JSON.parse(
  readFileSync(new URL('./fixtures.keywords.json', import.meta.url), 'utf8'),
);
/**
 * A REGRESSION LOCK, NOT A PARITY CHECK. The difference matters.
 *
 * It began as a parity check: the numbers in `fixtures.keywords.json` came from
 * running the Python reference implementation over ONE source CV and every JD
 * in the corpus, and these assertions compared to 1e-9. That proved the port
 * was faithful, and it was worth having while the port was in progress.
 *
 * It cannot stay that, for two reasons found on 2026-11-06:
 *
 * 1. The CV it needs is not here and must not be. The file read
 *    `../../cv.md`, which has not existed for some time, so this file died on
 *    load with ENOENT and took the whole suite red - which is how five broken
 *    tests went unnoticed. The real CV at `../../input/cv.md` no longer
 *    reproduces the numbers either: it has been edited since August, and only
 *    the revisions from 2026-08-11 to 2026-08-17 still match all nine.
 * 2. That CV cannot be committed. It carries a real employment history and
 *    names an employer's internal tooling. Anonymising the contact block alone
 *    was measured and does NOT move any score, so it was technically possible
 *    and still wrong.
 *
 * So the corpus is now `../example.cv.md`, an invented CV with a real stack,
 * and the expected numbers were regenerated from THIS implementation. The
 * test's job changed with them: it no longer proves the scores are right, it
 * proves they have not drifted. Any edit to checkKeywords that moves a score
 * fails here and has to be justified.
 *
 * The Python parity evidence is not lost - it is in the git history and in
 * docs/design-notes.md. It is simply no longer re-run, because the thing it
 * compared against is not in this repository.
 *
 * WHY THE CORPUS IS THE PUBLISHED EXAMPLE, not a fixture of its own. One file,
 * two jobs, on purpose: the README hands `example.cv.md` to a new user as the
 * input to try, and these tests keep it working. An example nobody runs rots,
 * and a fixture nobody reads is dead weight. The cost is that editing the
 * example moves these numbers, and CI says so at once - which is the right
 * alarm, not a nuisance. `oxfmt` ignores the file for the same reason it
 * ignores `templates/`: reformatting the corpus would silently re-score it.
 *
 * TO RE-LOCK after an intended change: regenerate score, passed and missing
 * for every case from the new implementation, and say in the commit message
 * which scores moved and why.
 */
const cv = readFileSync(new URL('../example.cv.md', import.meta.url), 'utf8');

const OPTS = { maxFeatures: 200, cutoff: 0.1, maxMissingDisplay: 10 };

const job = (over: Partial<JobPosting> = {}): JobPosting => ({
  title: '',
  company: '',
  description: '',
  rawText: '',
  requirements: [],
  keywords: [],
  language: 'en',
  ...over,
});

/**
 * One locked score per JD in the corpus, against `fixtures.cv.md`.
 *
 * SCORE is asserted exactly - it is what drives `passed` and the pipeline.
 *
 * The ORDER of the missing keywords is NOT asserted, and that is inherited
 * from the original reference: `significant_keywords` was a set there, CPython
 * randomizes string hashing per process, and a stable reverse sort preserves an
 * arbitrary order among equal-weight terms. Three consecutive runs of the same
 * input gave three different orders, and where there are more ties than
 * `maxMissingDisplay` the slice differed in membership too. This build is
 * deterministic, which the next test proves, so only the COUNT is pinned here.
 * See docs/design-notes.md.
 */
for (const [name, c] of Object.entries(fixtures)) {
  if (name.startsWith('_')) continue;
  test(`keywords: score is locked for ${name}`, () => {
    const got = checkKeywords(cv, job({ description: c.jd ?? '' }), 0.25, OPTS);
    assert.ok(Math.abs(got.score - c.score) < 1e-9, `score ${got.score} vs locked ${c.score}`);
    assert.equal(got.passed, c.passed);
    assert.equal(
      got.missingKeywords.length,
      c.missing.length,
      'same number of missing keywords reported',
    );
  });
}

test('keywords: missing-keyword output is deterministic across runs', () => {
  const jd = fixtures.inuits_senior_full_stack_engineer?.jd ?? '';
  const runs = Array.from({ length: 5 }, () =>
    checkKeywords(cv, job({ description: jd }), 0.25, OPTS).missingKeywords.join('|'),
  );
  assert.equal(new Set(runs).size, 1, 'identical every time');
});

test('keywords: score is locked with explicit job.keywords, including one outside the vocabulary', () => {
  const c = fixtures._with_keywords;
  assert.ok(c);
  const got = checkKeywords(
    cv,
    job({
      title: c.title ?? '',
      description: c.description ?? '',
      requirements: c.requirements ?? [],
      keywords: c.keywords ?? [],
    }),
    0.25,
    OPTS,
  );
  assert.ok(Math.abs(got.score - c.score) < 1e-9, `score ${got.score} vs locked ${c.score}`);
  assert.equal(got.missingKeywords.length, c.missing.length);
});

/* ---------- filter behaviour ---------- */

const stubChat: ChatProvider = {
  model: 'stub/none',
  complete: () => Promise.reject(new Error('unused')),
  object: () => Promise.reject(new Error('unused')),
  supportsVision: () => false,
};

const stubEmbeddings: EmbeddingProvider = {
  model: 'stub/none',
  dimensions: () => Promise.reject(new Error('stub embeddings: not expected to be called')),
  prefetch: () => Promise.reject(new Error('stub embeddings: not expected to be called')),
  embed: () => Promise.reject(new Error('stub embeddings: not expected to be called')),
  close: () => Promise.resolve(),
};

const trio = (p: ChatProvider): ChatProviders => ({ pro: p, flash: p, vision: p });

const ctx = (pdfText: string | null, description: string): FilterContext => ({
  // `markdown`, not `html`: the generator emits pandoc markdown and the
  // renderer turns that into the PDF. Filters grade `pdfText`.
  resume: { markdown: '# CV', pdfText, pngPage1: null, pageCount: 1, pageTexts: ['p'] },
  job: job({ description }),
  source: { text: cv, path: 'cv.md', instructions: null },
  config: loadConfig(),
  chat: trio(stubChat),
  embeddings: stubEmbeddings,
  targetLanguage: 'en',
});

test('keywordMatcher: missing pdfText fails rather than passing vacuously', async () => {
  const r = await keywordMatcher.evaluate(ctx(null, 'Node.js TypeScript'));
  assert.equal(r.passed, false);
  assert.equal(r.score, 0);
  assert.deepEqual([...r.issues], ['No PDF text available']);
});

test('keywordMatcher: a strong match passes and reports no issues', async () => {
  const jd = fixtures.remodevs_senior_fullstack_engineer_ai_assisted_codin?.jd ?? '';
  const r = await keywordMatcher.evaluate(ctx(cv, jd));
  assert.equal(r.passed, true);
  assert.ok(r.score > 0.7);
  assert.deepEqual([...r.issues], []);
});

test('keywordMatcher: a genuine domain mismatch scores low and names what is missing', async () => {
  const jd =
    'Computational geometry engineer. Required: 3D spatial transformations, ' +
    'vector mathematics, coordinate systems, mesh tessellation, NURBS surfaces, ' +
    'ray tracing, quaternion rotation, polygon triangulation, spatial indexing.';
  const r = await keywordMatcher.evaluate(ctx(cv, jd));
  assert.equal(r.passed, false, `expected a fail, got score ${r.score}`);
  assert.match(r.issues[0] ?? '', /Missing important keywords:/);
  assert.equal(r.suggestions.length, 1);
});

test('keywordMatcher: an all-stop-word job description passes', () => {
  const got = checkKeywords(cv, job({ description: 'the and of a to it' }), 0.25, OPTS);
  assert.equal(got.score, 1.0);
  assert.equal(got.passed, true);
});
