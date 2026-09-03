import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vectorSimilarity } from '../src/filters/vector-similarity.ts';
import { loadConfig } from '../src/config.ts';
import type { Config } from '../src/config.ts';
import type { FilterContext } from '../src/filters/base.ts';
import type { ChatProviders } from '../src/providers/ai-sdk.ts';
import type { ChatProvider } from '../src/providers/llm.ts';
import type { EmbeddingProvider } from '../src/providers/embeddings.ts';

const stubChat: ChatProvider = {
  model: 'stub/none',
  complete: () => Promise.reject(new Error('unused')),
  object: () => Promise.reject(new Error('unused')),
  supportsVision: () => false,
};

/** Returns fixed vectors, and records what it was asked to embed. */
const fakeEmbeddings = (vectors: number[][] | Error) => {
  const seen: string[][] = [];
  const provider: EmbeddingProvider = {
    model: 'fake/local',
    dimensions: () => Promise.resolve(3),
    prefetch: () => Promise.resolve(),
    embed: (texts) => {
      seen.push([...texts]);
      return vectors instanceof Error ? Promise.reject(vectors) : Promise.resolve(vectors);
    },
    close: () => Promise.resolve(),
  };
  return { provider, seen };
};

const withThreshold = (t: number): Config => {
  const base = loadConfig();
  return { ...base, thresholds: { ...base.thresholds, vector: t } };
};

const trio = (p: ChatProvider): ChatProviders => ({ pro: p, flash: p, vision: p });

const ctx = (embeddings: EmbeddingProvider, over: Partial<FilterContext> = {}): FilterContext => ({
  resume: {
    markdown: '<p/>',
    pdfText: 'RESUME TEXT',
    pngPage1: null,
    pageCount: 1,
    pageTexts: ['p'],
  },
  job: {
    title: 'Senior Node.js Engineer',
    company: 'Acme',
    description: 'Build backend services',
    rawText: 'Build backend services',
    requirements: ['Node.js'],
    keywords: [],
    language: 'en',
  },
  source: { text: 'CV', path: 'cv.md', instructions: null },
  config: withThreshold(0.55),
  chat: trio(stubChat),
  embeddings,
  targetLanguage: 'en',
  ...over,
});

test('vector: similar vectors pass with the raw cosine as score', async () => {
  const { provider } = fakeEmbeddings([
    [1, 0, 0],
    [0.8, 0.6, 0],
  ]);
  const r = await vectorSimilarity.evaluate(ctx(provider));
  assert.ok(Math.abs(r.score - 0.8) < 1e-12, `score ${r.score}`);
  assert.equal(r.passed, true);
  assert.deepEqual([...r.issues], []);
});

test('vector: dissimilar vectors fail and name the score', async () => {
  const { provider } = fakeEmbeddings([
    [1, 0, 0],
    [0.3, 0.954, 0],
  ]);
  const r = await vectorSimilarity.evaluate(ctx(provider));
  assert.equal(r.passed, false);
  assert.match(r.issues[0] ?? '', /Low semantic similarity to job posting \(0\.30\)/);
});

test('vector: the score is RAW cosine, never rescaled to (cos+1)/2', async () => {
  // A (x+1)/2 rescale would squash everything into [0.5,1.0] and make the
  // threshold unreachable - a bread recipe scored 0.72 and passed at 0.4.
  const { provider } = fakeEmbeddings([
    [1, 0],
    [0, 1],
  ]);
  const r = await vectorSimilarity.evaluate(ctx(provider, { config: withThreshold(0.4) }));
  assert.equal(r.score, 0, 'orthogonal is 0, not 0.5');
  assert.equal(r.passed, false, 'and it must be able to fail');
});

test('vector: embeds the CV text and the assembled job text, in that order', async () => {
  const { provider, seen } = fakeEmbeddings([
    [1, 0, 0],
    [1, 0, 0],
  ]);
  await vectorSimilarity.evaluate(ctx(provider));
  assert.equal(seen[0]?.length, 2);
  assert.equal(seen[0]?.[0], 'RESUME TEXT');
  assert.equal(seen[0]?.[1], 'Senior Node.js Engineer Build backend services Node.js');
});

test('vector: an embedding failure is SKIPPED, never a passing 1.0', async () => {
  // This is the exact failure mode that keeps a filter dead and quiet: a hard
  // 401 became `passed: true, score: 1.0`.
  const { provider } = fakeEmbeddings(new Error('model unreachable'));
  const r = await vectorSimilarity.evaluate(ctx(provider));
  assert.match(r.issues[0] ?? '', /SKIPPED/);
  assert.match(r.issues[0] ?? '', /model unreachable/);
  assert.ok(Number.isNaN(r.score), 'a skip must not report a score of 1.0');
});

test('vector: an uncalibrated threshold is SKIPPED rather than guessed', async () => {
  const { provider, seen } = fakeEmbeddings([
    [1, 0],
    [1, 0],
  ]);
  const r = await vectorSimilarity.evaluate(ctx(provider, { config: withThreshold(Number.NaN) }));
  assert.equal(seen.length, 0, 'no embedding call - nothing to compare against');
  assert.match(r.issues[0] ?? '', /calibrated/);
});

test('vector: a wrong number of vectors is SKIPPED, not scored', async () => {
  const { provider } = fakeEmbeddings([[1, 0]]);
  const r = await vectorSimilarity.evaluate(ctx(provider));
  assert.match(r.issues[0] ?? '', /SKIPPED/);
  assert.ok(Number.isNaN(r.score));
});

test('vector: missing pdfText fails rather than passing vacuously', async () => {
  const { provider } = fakeEmbeddings([
    [1, 0],
    [1, 0],
  ]);
  const r = await vectorSimilarity.evaluate(
    ctx(provider, {
      resume: { markdown: '<p/>', pdfText: null, pngPage1: null, pageCount: 1, pageTexts: ['p'] },
    }),
  );
  assert.equal(r.passed, false);
  assert.equal(r.score, 0);
  assert.deepEqual([...r.issues], ['No PDF text available']);
});
