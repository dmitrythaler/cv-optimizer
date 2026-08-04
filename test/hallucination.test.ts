import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hallucination } from '../src/filters/hallucination.ts';
import {
  LENIENT_PROMPT,
  STRICT_PROMPT,
  buildUserPrompt,
  currentDateLine,
} from '../src/prompts/hallucination.ts';
import { loadConfig } from '../src/config.ts';
import type { FilterContext } from '../src/filters/base.ts';
import type { EmbeddingProvider } from '../src/providers/embeddings.ts';
import type { ChatProviders } from '../src/providers/ai-sdk.ts';
import type { ChatProvider, ChatRequest } from '../src/providers/llm.ts';
import type { HallucinationResult } from '../src/filters/hallucination.ts';

/** Captures what the filter sends, and replies with a canned verdict. */
const fakeChat = (reply: HallucinationResult) => {
  const seen: ChatRequest[] = [];
  const provider: ChatProvider = {
    model: 'fake/model',
    complete: () => Promise.reject(new Error('not used')),
    object: <T>(req: ChatRequest): Promise<T> => {
      seen.push(req);
      return Promise.resolve(reply as T);
    },
    supportsVision: () => false,
  };
  return { provider, seen };
};

const stubEmbeddings: EmbeddingProvider = {
  model: 'stub/none',
  dimensions: () => Promise.reject(new Error('stub embeddings: not expected to be called')),
  prefetch: () => Promise.reject(new Error('stub embeddings: not expected to be called')),
  embed: () => Promise.reject(new Error('stub embeddings: not expected to be called')),
  close: () => Promise.resolve(),
};

const trio = (p: ChatProvider): ChatProviders => ({ pro: p, flash: p, vision: p });

const ctx = (chat: ChatProvider, over: Partial<FilterContext> = {}): FilterContext => ({
  resume: {
    html: '<header class="header"><h1 class="name">D</h1></header>',
    pdfText: null,
    pngPage1: null,
    pageCount: 1,
    pageTexts: ['p1'],
  },
  job: {
    title: 't',
    company: 'c',
    description: 'd',
    requirements: [],
    keywords: [],
    language: 'en',
  },
  source: { text: 'ORIGINAL CV BODY', path: 'cv.md', instructions: null },
  config: loadConfig(),
  chat: trio(chat),
  embeddings: stubEmbeddings,
  targetLanguage: 'en',
  ...over,
});

test('hallucination: clean score passes, concerns still surface as issues', async () => {
  const { provider } = fakeChat({
    no_hallucination_score: 0.98,
    concerns: ['minor umbrella term'],
    reasoning: 'faithful',
  });
  const r = await hallucination.evaluate(ctx(provider));
  assert.equal(r.passed, true);
  assert.equal(r.score, 0.98);
  assert.equal(r.threshold, 0.9);
  assert.deepEqual(r.issues, ['minor umbrella term']);
  assert.deepEqual(r.suggestions, []);
});

test('hallucination: below threshold fails and explains why', async () => {
  const { provider } = fakeChat({
    no_hallucination_score: 0.82,
    concerns: ['invented iGaming domain experience'],
    reasoning: 'claims not supported by source',
  });
  const r = await hallucination.evaluate(ctx(provider));
  assert.equal(r.passed, false);
  assert.equal(r.score, 0.82);
  assert.match(r.suggestions[0] ?? '', /Score 0\.82 below 0\.9 threshold\./);
  assert.match(r.suggestions[0] ?? '', /claims not supported by source/);
});

test('hallucination: exactly at threshold passes', async () => {
  const { provider } = fakeChat({ no_hallucination_score: 0.9, concerns: [], reasoning: 'ok' });
  const r = await hallucination.evaluate(ctx(provider));
  assert.equal(r.passed, true);
});

test('hallucination: strict prompt used by default, with the date line appended', async () => {
  const { provider, seen } = fakeChat({
    no_hallucination_score: 1,
    concerns: [],
    reasoning: 'ok',
  });
  await hallucination.evaluate(ctx(provider));
  const system = seen[0]?.system ?? '';
  assert.ok(system.startsWith(STRICT_PROMPT), 'system prompt starts with STRICT_PROMPT verbatim');
  assert.ok(system.includes(currentDateLine()), 'current date appended');
  assert.ok(!system.includes('BLOCK (score below 0.5)'), 'lenient prompt not used');
});

test('hallucination: noShame swaps in the lenient prompt and its 0.6 bound', async () => {
  const { provider, seen } = fakeChat({
    no_hallucination_score: 0.65,
    concerns: [],
    reasoning: 'stretched but plausible',
  });
  const base = loadConfig();
  const r = await hallucination.evaluate(ctx(provider, { config: { ...base, noShame: true } }));
  assert.equal(r.threshold, 0.6);
  assert.equal(r.passed, true, '0.65 clears the lenient bound but not the strict one');
  assert.ok((seen[0]?.system ?? '').startsWith(LENIENT_PROMPT));
});

test('hallucination: a provider failure propagates rather than becoming a pass', async () => {
  const provider: ChatProvider = {
    model: 'fake/model',
    complete: () => Promise.reject(new Error('nope')),
    object: () => Promise.reject(new Error('model unreachable')),
    supportsVision: () => false,
  };
  await assert.rejects(() => hallucination.evaluate(ctx(provider)), /model unreachable/);
});

/* ---------- prompt assembly ---------- */

test('prompt: instructions are included as source of truth when present', () => {
  const withOut = buildUserPrompt({
    sourceContent: 'CV',
    sourceInstructions: null,
    optimizedContent: 'OPT',
    languageCode: 'en',
  });
  assert.ok(!withOut.includes('USER INSTRUCTIONS'));

  const withIn = buildUserPrompt({
    sourceContent: 'CV',
    sourceInstructions: 'do not change 15+ years',
    optimizedContent: 'OPT',
    languageCode: 'en',
  });
  assert.ok(withIn.includes('=== USER INSTRUCTIONS'));
  assert.ok(withIn.includes('do not change 15+ years'));
});

test('prompt: language note only for non-English, naming the language', () => {
  const en = buildUserPrompt({
    sourceContent: 'CV',
    sourceInstructions: null,
    optimizedContent: 'OPT',
    languageCode: 'en',
  });
  assert.ok(!en.includes('LANGUAGE NOTE'));

  const pl = buildUserPrompt({
    sourceContent: 'CV',
    sourceInstructions: null,
    optimizedContent: 'OPT',
    languageCode: 'pl',
  });
  assert.ok(pl.includes('=== LANGUAGE NOTE ==='));
  assert.ok(pl.includes('Polish'), 'language code resolved to its English name');
});

test('prompt: both prompts keep the trailing space the Python has', () => {
  // Guards against an editor or formatter silently trimming it.
  assert.ok(STRICT_PROMPT.startsWith('You are a resume verification specialist. \n'));
  assert.ok(LENIENT_PROMPT.startsWith('You are a resume verification specialist. \n'));
});

test('prompt: current date is formatted as "Month YYYY"', () => {
  assert.match(currentDateLine(new Date('2026-08-04T12:00:00Z')), /^Today's date: August 2026$/);
});
