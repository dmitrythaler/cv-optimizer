import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkFilters } from '../src/check-filters.ts';
import { loadConfig } from '../src/config.ts';

const CV = new URL('../../cv.md', import.meta.url).pathname;
const JD = new URL(
  '../../applications/20260731-1600-inuits_senior_full_stack_engineer/jd.txt',
  import.meta.url,
).pathname;

/**
 * These tests only cover name handling. A full run needs an API key and the
 * embedding model, so it belongs in manual use, not in the suite.
 *
 * Name checks happen before any provider is built, so these are cheap.
 */

test('check-filters: an unknown name gives exit code 1', async () => {
  assert.equal(await checkFilters(CV, JD, 'NoSuchFilter', loadConfig()), 1);
});

test('check-filters: one bad name in a good list still gives exit code 1', async () => {
  assert.equal(await checkFilters(CV, JD, 'KeywordMatcher,Nope', loadConfig()), 1);
});

test('check-filters: an empty list gives exit code 1', async () => {
  assert.equal(await checkFilters(CV, JD, ' , ', loadConfig()), 1);
});
