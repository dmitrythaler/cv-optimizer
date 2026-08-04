import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cosine } from '../src/providers/embeddings.ts';
import { loadConfig } from '../src/config.ts';

test('cosine: identical vectors are 1', () => {
  assert.equal(cosine([1, 2, 3], [1, 2, 3]), 1);
});

test('cosine: orthogonal vectors are 0', () => {
  assert.equal(cosine([1, 0], [0, 1]), 0);
});

test('cosine: opposite vectors are -1', () => {
  assert.equal(cosine([1, 0], [-1, 0]), -1);
});

test('cosine: is not rescaled into [0,1]', () => {
  // The Python original mapped cosine through (x+1)/2, which compressed the
  // real range into [0.5,1] and made the threshold unreachable. Guard that.
  assert.ok(cosine([1, 0], [-1, 0]) < 0);
});

test('cosine: rejects mismatched lengths', () => {
  assert.throws(() => cosine([1, 2], [1, 2, 3]), /length mismatch/);
});

test('cosine: zero vector yields 0 rather than NaN', () => {
  assert.equal(cosine([0, 0], [1, 2]), 0);
});

test('config: vector threshold is uncalibrated until measured', () => {
  const c = loadConfig();
  // NaN makes every comparison false, so the filter cannot silently pass.
  assert.ok(Number.isNaN(c.thresholds.vector), 'THRESHOLD_VECTOR must not default to a guess');
});

test('config: embedding is local, with no api key in play', () => {
  const c = loadConfig();
  assert.ok(!c.embedding.model.includes('/'.concat('/')), 'not a URL');
  assert.ok(c.embedding.maxInputTokens > 512, 'window must fit a 2-page CV');
});

test('config: rejects non-numeric env override', () => {
  process.env.MAX_ITERATIONS = 'banana';
  assert.throws(() => loadConfig(), /must be a number/);
  delete process.env.MAX_ITERATIONS;
});

test('version: comes from package.json, not a hardcoded literal', async () => {
  const { version } = await import('../src/version.ts');
  const pkg: { version: string } = JSON.parse(
    await import('node:fs/promises').then((fs) => fs.readFile('package.json', 'utf8')),
  );
  assert.equal(version, pkg.version);
  assert.notEqual(version, 'unknown');
});
