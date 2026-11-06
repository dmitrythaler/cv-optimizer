import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { layoutChecker } from '../src/filters/layout-checker.ts';
import type { LayoutResult } from '../src/filters/layout-checker.ts';
import { SYSTEM_PROMPT, buildUserPrompt } from '../src/prompts/layout.ts';
import { loadConfig } from '../src/config.ts';
import type { FilterContext } from '../src/filters/base.ts';
import type { EmbeddingProvider } from '../src/providers/embeddings.ts';
import type { ChatProviders } from '../src/providers/ai-sdk.ts';
import type { ChatProvider, ChatRequest } from '../src/providers/llm.ts';

const OK: LayoutResult = { broken: false, defects: [] };

const fakeChat = (reply: LayoutResult, opts: { vision?: boolean } = {}) => {
  const seen: ChatRequest[] = [];
  const provider: ChatProvider = {
    model: 'fake/vision',
    complete: () => Promise.reject(new Error('not used')),
    object: <T>(req: ChatRequest): Promise<T> => {
      seen.push(req);
      return Promise.resolve(reply as T);
    },
    supportsVision: () => opts.vision !== false,
  };
  return { provider, seen };
};

const stubEmbeddings: EmbeddingProvider = {
  model: 'stub/none',
  dimensions: () => Promise.reject(new Error('unused')),
  prefetch: () => Promise.reject(new Error('unused')),
  embed: () => Promise.reject(new Error('unused')),
  close: () => Promise.resolve(),
};

const trio = (p: ChatProvider): ChatProviders => ({ pro: p, flash: p, vision: p });

const ctx = (chat: ChatProvider, over: Partial<FilterContext> = {}): FilterContext => ({
  resume: {
    markdown: '<p>cv</p>',
    pdfText: 'RESUME TEXT',
    pngPage1: new Uint8Array([137, 80, 78, 71]),
    pageCount: 2,
    pageTexts: ['p1', 'p2'],
  },
  job: {
    title: 'Senior Node.js Engineer',
    company: 'Acme',
    description: 'Build things',
    rawText: 'Build things',
    requirements: [],
    keywords: [],
    language: 'en',
  },
  source: { text: 'CV', path: 'cv.md', instructions: null },
  config: loadConfig(),
  chat: trio(chat),
  embeddings: stubEmbeddings,
  targetLanguage: 'en',
  ...over,
});

/* ---------- prompt ---------- */

test('prompt: SYSTEM_PROMPT has not drifted', () => {
  assert.equal(
    createHash('sha256').update(SYSTEM_PROMPT).digest('hex'),
    'f971ecc7983fcb5c41ecd035c5e4e2fbaa00854680c5d484a84c488b207a28a7',
  );
});

test('prompt: refuses taste, and never sees the job', () => {
  // The reason this filter exists separately. If it starts grading style or
  // fit, the split has quietly undone itself.
  assert.ok(SYSTEM_PROMPT.includes('NOT a judge of taste'));
  assert.ok(!/keyword|experience|education|ATS/i.test(SYSTEM_PROMPT), 'no screening language');
  const user = buildUserPrompt(2);
  assert.ok(!/job|position|company/i.test(user), 'the job never reaches this prompt');
});

test('prompt: says the expected answer for a normal page is "not broken"', () => {
  // Without this, a model asked to find problems will always find one.
  assert.ok(SYSTEM_PROMPT.includes('That is the expected answer for a normal resume'));
});

/* ---------- filter ---------- */

test('layout: a clean page passes with no issues', async () => {
  const r = await layoutChecker.evaluate(ctx(fakeChat(OK).provider));
  assert.equal(r.passed, true);
  assert.equal(r.score, 1);
  assert.equal(r.threshold, 1);
  assert.deepEqual([...r.issues], []);
  assert.deepEqual([...r.suggestions], []);
});

test('layout: a real defect fails and names it', async () => {
  const { provider } = fakeChat({
    broken: true,
    defects: ['Right column text clipped at the page edge'],
  });
  const r = await layoutChecker.evaluate(ctx(provider));
  assert.equal(r.passed, false);
  assert.equal(r.score, 0);
  assert.deepEqual([...r.issues], ['Right column text clipped at the page edge']);
});

test('layout: broken=true with an empty defect list is NOT a failure', async () => {
  // A model that asserts a problem and cannot name one has not found one. This
  // filter can veto a whole run, so it must not do so on an empty claim.
  const { provider } = fakeChat({ broken: true, defects: [] });
  const r = await layoutChecker.evaluate(ctx(provider));
  assert.equal(r.passed, true, 'no evidence, no failure');
  assert.equal(r.score, 1);
});

test('layout: the page image is actually sent', async () => {
  const { provider, seen } = fakeChat(OK);
  await layoutChecker.evaluate(ctx(provider));
  assert.ok(seen[0]?.image instanceof Uint8Array, 'image attached');
  assert.ok(seen[0]?.system?.startsWith(SYSTEM_PROMPT));
});

test('layout: a provider without vision is SKIPPED, not judged', async () => {
  // A skip does NOT block the run - a missing API key must not fail a good CV -
  // but it reports NaN, never a passing 1.0. The NaN is what tells a reader
  // that no judgement was made. It is also logged at WARN.
  const { provider } = fakeChat(OK, { vision: false });
  const r = await layoutChecker.evaluate(ctx(provider));
  assert.ok(Number.isNaN(r.score), 'a skip is NaN, never a passing 1.0');
  assert.equal(r.passed, true, 'a config fault does not fail the CV');
  assert.match(r.issues.join(' '), /no vision support/);
});

test('layout: no rendered image is a real failure, not a skip', async () => {
  const { provider } = fakeChat(OK);
  const r = await layoutChecker.evaluate(
    ctx(provider, {
      resume: {
        markdown: '<p>x</p>',
        pdfText: 't',
        pngPage1: null,
        pageCount: null,
        pageTexts: null,
      },
    }),
  );
  assert.equal(r.passed, false);
  assert.equal(r.score, 0, 'a CV that will not render IS broken');
  assert.ok(!Number.isNaN(r.score), 'not a skip');
});

test('layout: runs last, after the filters that can explain themselves', () => {
  assert.equal(layoutChecker.priority, 8);
});
