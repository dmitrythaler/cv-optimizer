import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentLength } from '../src/filters/content-length.ts';
import { dataValidator, validateMarkdown } from '../src/filters/data-validator.ts';
import { all } from '../src/filters/index.ts';
import { loadConfig } from '../src/config.ts';
import type { FilterContext } from '../src/filters/base.ts';
import type { OptimizedResume } from '../src/types.ts';
import type { EmbeddingProvider } from '../src/providers/embeddings.ts';
import type { ChatProviders } from '../src/providers/ai-sdk.ts';
import type { ChatProvider } from '../src/providers/llm.ts';

const VALID_MD = [
  '[John Dow]{.cv-name}',
  '',
  '::: {.contacts}',
  'john@dow.dev',
  ':::',
  '',
  '::: {.summary}',
  'experience',
  ':::',
  '',
  '## Selected Professional Experience',
  '',
  '::: {.entry}',
  '### **Acme** - *Engineer*',
  ':::',
].join('\n');

const resume = (over: Partial<OptimizedResume> = {}): OptimizedResume => ({
  markdown: VALID_MD,
  pdfText: 'text',
  pngPage1: null,
  pageCount: 1,
  pageTexts: ['page one'],
  ...over,
});

const stubChat: ChatProvider = {
  model: 'stub/none',
  complete: () => Promise.reject(new Error('stub chat: not expected to be called')),
  object: () => Promise.reject(new Error('stub chat: not expected to be called')),
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

const ctx = (
  over: Partial<OptimizedResume> = {},
  extra: Partial<FilterContext> = {},
): FilterContext => ({
  resume: resume(over),
  job: {
    title: 't',
    company: 'c',
    description: 'd',
    rawText: 'd',
    requirements: [],
    keywords: [],
    language: 'en',
  },
  source: { text: 'cv', path: 'cv.md', instructions: null },
  config: loadConfig(),
  chat: trio(stubChat),
  embeddings: stubEmbeddings,
  targetLanguage: 'en',
  ...extra,
});

/* ---------- ContentLengthChecker ---------- */

test('contentLength: one page passes', async () => {
  const r = await contentLength.evaluate(ctx());
  assert.equal(r.passed, true);
  assert.equal(r.score, 1.0);
});

test('contentLength: unrendered input passes - nothing to measure', async () => {
  const r = await contentLength.evaluate(ctx({ pageCount: null, pageTexts: null }));
  assert.equal(r.passed, true);
});

test('contentLength: three pages fails', async () => {
  const r = await contentLength.evaluate(ctx({ pageCount: 3, pageTexts: ['a', 'b', 'c'] }));
  assert.equal(r.passed, false);
  assert.equal(r.score, 0.0);
  assert.match(r.issues[0] ?? '', /Resume is 3 pages/);
});

test('contentLength: two full pages pass', async () => {
  const full = 'x'.repeat(6000); // above the 5000 overflow bound
  const r = await contentLength.evaluate(ctx({ pageCount: 2, pageTexts: ['page one', full] }));
  assert.equal(r.passed, true);
});

test('contentLength: two pages with a nearly-empty page 2 is overflow', async () => {
  const r = await contentLength.evaluate(ctx({ pageCount: 2, pageTexts: ['page one', 'spill'] }));
  assert.equal(r.passed, false);
  assert.match(r.issues[0] ?? '', /content overflow from page 1/);
});

test('contentLength: two pages with a fully empty page 2 passes (len > 0 guard)', async () => {
  // Deliberate: a zero-length page 2 is NOT overflow.
  const r = await contentLength.evaluate(ctx({ pageCount: 2, pageTexts: ['page one', '   '] }));
  assert.equal(r.passed, true);
});

/* ---------- DataValidator ---------- */

test('dataValidator: valid markdown passes', async () => {
  const r = await dataValidator.evaluate(ctx());
  assert.equal(r.passed, true);
  assert.deepEqual(r.issues, []);
});

test('dataValidator: a missing name span is reported', () => {
  const issues = validateMarkdown(VALID_MD.replace('[John Dow]{.cv-name}', 'John Dow'));
  assert.deepEqual(issues, ['Missing the name span, [Name]{.cv-name}']);
});

test('dataValidator: a missing contacts fence is reported', () => {
  const issues = validateMarkdown(VALID_MD.replace('::: {.contacts}', ''));
  // Removing the opening fence also unbalances the count, which is the point:
  // pandoc does not fail on this, it renders the CV unstyled.
  assert.ok(issues.includes('Missing the ::: {.contacts} block'));
  assert.ok(issues.some((i) => i.startsWith('Unbalanced pandoc fences')));
});

test('dataValidator: an unclosed fence is caught, because pandoc will not fail', () => {
  const issues = validateMarkdown(`${VALID_MD}\n\n::: {.entry}\n### **X** - *Y*`);
  assert.deepEqual(issues, [
    'Unbalanced pandoc fences: 4 opened, 3 closed. ' +
      'An unclosed fence renders unstyled instead of failing.',
  ]);
});

test('dataValidator: missing sections reported', () => {
  const issues = validateMarkdown(
    VALID_MD.replace('## Selected Professional Experience', 'Selected Professional Experience'),
  );
  assert.deepEqual(issues, ['Resume has no content sections (no "## " heading)']);
});

test('dataValidator: raw HTML is rejected, case-insensitively', () => {
  const issues = validateMarkdown(`${VALID_MD}\n<SCRIPT>alert(1)</SCRIPT>`);
  assert.deepEqual(issues, ['Raw HTML tag <SCRIPT> is not allowed; the output is markdown']);
});

test('dataValidator: a valid document reports nothing', () => {
  assert.deepEqual(validateMarkdown(VALID_MD), []);
});

test('dataValidator: failure carries a suggestion, success does not', async () => {
  const bad = await dataValidator.evaluate(ctx({ markdown: 'nothing' }));
  assert.equal(bad.passed, false);
  assert.equal(bad.suggestions.length, 1);
  const good = await dataValidator.evaluate(ctx());
  assert.deepEqual(good.suggestions, []);
});

/* ---------- registry ---------- */

test('registry: filters registered, ordered by priority', () => {
  const names = all().map((f) => f.name);
  assert.deepEqual(names, [
    'ContentLengthChecker',
    'DataValidator',
    'HallucinationChecker',
    'KeywordMatcher',
    'AtsChecker',
    'VectorSimilarityMatcher',
    'AiGeneratedChecker',
    'LayoutChecker',
  ]);
  assert.deepEqual(
    all().map((f) => f.priority),
    [0, 1, 3, 4, 5, 6, 7, 8],
  );
});
