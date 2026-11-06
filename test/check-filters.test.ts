import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkFilters } from '../src/check-filters.ts';
import { loadConfig } from '../src/config.ts';

/**
 * These tests only cover name handling. A full run needs an API key and the
 * embedding model, so it belongs in manual use, not in the suite.
 *
 * Name checks happen before any provider is built, and before either path is
 * opened, so these are cheap - and the files only have to exist on paper.
 *
 * They are real paths inside the repo all the same. The two they used to point
 * at, `../../cv.md` and a dated folder under `../../applications/`, left the
 * repo entirely and neither still exists. Nothing failed, because nothing reads
 * them, so the rot was invisible: exactly the shape of the bug that took the
 * suite down in test/keyword-matcher.test.ts. A path that cannot be checked is
 * a path that drifts.
 */
const CV = new URL('../example.cv.md', import.meta.url).pathname;
const JD = new URL('./fixtures.raw-jd.txt', import.meta.url).pathname;

test('check-filters: an unknown name gives exit code 1', async () => {
  assert.equal(await checkFilters(CV, JD, 'NoSuchFilter', loadConfig()), 1);
});

test('check-filters: one bad name in a good list still gives exit code 1', async () => {
  assert.equal(await checkFilters(CV, JD, 'KeywordMatcher,Nope', loadConfig()), 1);
});

test('check-filters: an empty list gives exit code 1', async () => {
  assert.equal(await checkFilters(CV, JD, ' , ', loadConfig()), 1);
});
