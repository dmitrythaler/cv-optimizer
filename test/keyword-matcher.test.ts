import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkKeywords } from '../src/filters/keyword-matcher.ts';
import { keywordMatcher } from '../src/filters/keyword-matcher.ts';
import { loadConfig } from '../src/config.ts';
import type { JobPosting } from '../src/types.ts';
import type { FilterContext } from '../src/filters/base.ts';
import type { EmbeddingProvider } from '../src/providers/embeddings.ts';
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
const cv = readFileSync(new URL('../../cv.md', import.meta.url), 'utf8');
const OPTS = { maxFeatures: 200, cutoff: 0.1, maxMissingDisplay: 10 };

const job = (over: Partial<JobPosting> = {}): JobPosting => ({
  title: '',
  company: '',
  description: '',
  requirements: [],
  keywords: [],
  language: 'en',
  ...over,
});

/**
 * Parity against the real Python. Reference scores were produced by running
 * hr-breaker's own check_keywords() over cv.md and every JD in the corpus.
 *
 * SCORE is asserted exactly - it is what drives `passed` and the pipeline.
 *
 * The ORDER of missing_keywords is deliberately NOT asserted against Python,
 * because Python cannot reproduce it either: `significant_keywords` is a set,
 * CPython randomizes string hashing per process, and `sorted(..., reverse=True)`
 * is stable - so it preserves an arbitrary order among equal-weight terms.
 * Three consecutive runs of the same input gave three different orders. Where
 * there are more than `maxMissingDisplay` ties the slice even differs in
 * membership. This port is deterministic instead. See docs/porting-notes.md.
 */
for (const [name, c] of Object.entries(fixtures)) {
  if (name.startsWith('_')) continue;
  test(`keywords: matches hr-breaker exactly on ${name}`, () => {
    const got = checkKeywords(cv, job({ description: c.jd ?? '' }), 0.25, OPTS);
    assert.ok(Math.abs(got.score - c.score) < 1e-9, `score ${got.score} vs python ${c.score}`);
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
  assert.equal(new Set(runs).size, 1, 'identical every time - unlike the Python original');
});

test('keywords: matches hr-breaker with explicit job.keywords, including one outside the vocabulary', () => {
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
  assert.ok(Math.abs(got.score - c.score) < 1e-9, `score ${got.score} vs python ${c.score}`);
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

const ctx = (pdfText: string | null, description: string): FilterContext => ({
  resume: { html: '<p/>', pdfText, pngPage1: null, pageCount: 1, pageTexts: ['p'] },
  job: job({ description }),
  source: { text: cv, path: 'cv.md', instructions: null },
  config: loadConfig(),
  chat: stubChat,
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
