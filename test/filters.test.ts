import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentLength } from '../src/filters/content-length.ts';
import { dataValidator, validateHtml } from '../src/filters/data-validator.ts';
import { all } from '../src/filters/index.ts';
import { loadConfig } from '../src/config.ts';
import type { FilterContext } from '../src/filters/base.ts';
import type { OptimizedResume } from '../src/types.ts';
import type { EmbeddingProvider } from '../src/providers/embeddings.ts';
import type { ChatProviders } from '../src/providers/ai-sdk.ts';
import type { ChatProvider } from '../src/providers/llm.ts';

const VALID_HTML =
  '<header class="header"><h1 class="name">Dmitry Thaler</h1></header>' +
  '<section class="section"><p>experience</p></section>';

const resume = (over: Partial<OptimizedResume> = {}): OptimizedResume => ({
  html: VALID_HTML,
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
  // Quirk preserved from the Python original: zero-length page 2 is NOT overflow.
  const r = await contentLength.evaluate(ctx({ pageCount: 2, pageTexts: ['page one', '   '] }));
  assert.equal(r.passed, true);
});

/* ---------- DataValidator ---------- */

test('dataValidator: valid html passes', async () => {
  const r = await dataValidator.evaluate(ctx());
  assert.equal(r.passed, true);
  assert.deepEqual(r.issues, []);
});

test('dataValidator: missing header reported, name NOT also reported', () => {
  // Faithful to the Python else-if: one issue, not two.
  const issues = validateHtml('<section class="section">x</section>');
  assert.deepEqual(issues, ["Missing header element with class='header'"]);
});

test('dataValidator: header present but name missing', () => {
  const issues = validateHtml(
    '<header class="header"></header><section class="section">x</section>',
  );
  assert.deepEqual(issues, ["Missing name (h1 with class='name') in header"]);
});

test('dataValidator: missing sections reported', () => {
  const issues = validateHtml('<header class="header"><h1 class="name">D</h1></header>');
  assert.deepEqual(issues, ['Resume has no content sections']);
});

test('dataValidator: script tags rejected, case-insensitively', () => {
  const issues = validateHtml(`${VALID_HTML}<SCRIPT>alert(1)</SCRIPT>`);
  assert.deepEqual(issues, ['Script tags are not allowed']);
});

test('dataValidator: style tags are allowed', () => {
  const issues = validateHtml(`${VALID_HTML}<style>.name{color:red}</style>`);
  assert.deepEqual(issues, []);
});

test('dataValidator: failure carries a suggestion, success does not', async () => {
  const bad = await dataValidator.evaluate(ctx({ html: '<div>nothing</div>' }));
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
    'VisionChecker',
    'VectorSimilarityMatcher',
    'AiGeneratedChecker',
  ]);
  assert.deepEqual(
    all().map((f) => f.priority),
    [0, 1, 3, 4, 5, 6, 7],
  );
});
