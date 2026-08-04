import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { aiGenerated } from '../src/filters/ai-generated.ts';
import type { AiGeneratedResult } from '../src/filters/ai-generated.ts';
import { SYSTEM_PROMPT, buildUserPrompt, currentDateLine } from '../src/prompts/ai-generated.ts';
import { loadConfig } from '../src/config.ts';
import type { FilterContext } from '../src/filters/base.ts';
import type { ChatProviders } from '../src/providers/ai-sdk.ts';
import type { ChatProvider, ChatRequest } from '../src/providers/llm.ts';
import type { EmbeddingProvider } from '../src/providers/embeddings.ts';

const stubEmbeddings: EmbeddingProvider = {
  model: 'stub/none',
  dimensions: () => Promise.reject(new Error('unused')),
  prefetch: () => Promise.reject(new Error('unused')),
  embed: () => Promise.reject(new Error('unused')),
  close: () => Promise.resolve(),
};

const fakeChat = (reply: AiGeneratedResult) => {
  const seen: ChatRequest[] = [];
  const provider: ChatProvider = {
    model: 'fake/model',
    complete: () => Promise.reject(new Error('unused')),
    object: <T>(req: ChatRequest): Promise<T> => {
      seen.push(req);
      return Promise.resolve(reply as T);
    },
    supportsVision: () => false,
  };
  return { provider, seen };
};

const trio = (p: ChatProvider): ChatProviders => ({ pro: p, flash: p, vision: p });

const ctx = (chat: ChatProvider, over: Partial<FilterContext> = {}): FilterContext => ({
  resume: {
    html: '<p>html</p>',
    pdfText: 'RESUME TEXT',
    pngPage1: null,
    pageCount: 1,
    pageTexts: ['p'],
  },
  job: {
    title: 't',
    company: 'c',
    description: 'd',
    rawText: 'd',
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

test('prompt: SYSTEM_PROMPT is identical to the Python original', () => {
  const py = readFileSync(
    new URL('../../hr-breaker/src/hr_breaker/agents/ai_generated_detector.py', import.meta.url),
    'utf8',
  );
  const want = /SYSTEM_PROMPT\s*=\s*"""([\s\S]*?)"""/.exec(py)?.[1];
  assert.ok(want, 'SYSTEM_PROMPT found in the Python file');
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  assert.equal(sha(SYSTEM_PROMPT), sha(want), 'the prompt must not change');
});

test('prompt: the language note is added only for a language other than English', () => {
  const en = buildUserPrompt({ resumeText: 'r', languageCode: 'en' });
  assert.ok(!en.includes('LANGUAGE NOTE'));
  const pl = buildUserPrompt({ resumeText: 'r', languageCode: 'pl' });
  assert.ok(pl.includes('=== LANGUAGE NOTE ==='));
  assert.ok(pl.includes('Polish'));
});

/* ---------- filter ---------- */

test('ai: the score is inverted - a low probability gives a high score', () => {
  // The model reports the chance that a machine wrote the text. The filter
  // reports the opposite. All filters use "high is good".
  const r: AiGeneratedResult = { is_ai_generated: false, ai_probability: 0.15, indicators: [] };
  assert.equal(1 - r.ai_probability, 0.85);
});

test('ai: human-looking text passes', async () => {
  const { provider } = fakeChat({ is_ai_generated: false, ai_probability: 0.15, indicators: [] });
  const r = await aiGenerated.evaluate(ctx(provider));
  assert.equal(r.passed, true);
  assert.ok(Math.abs(r.score - 0.85) < 1e-12);
  assert.equal(r.threshold, 0.4);
  assert.deepEqual([...r.issues], []);
  assert.deepEqual([...r.suggestions], []);
});

test('ai: machine-looking text fails and each indicator is listed', async () => {
  const { provider } = fakeChat({
    is_ai_generated: true,
    ai_probability: 0.8,
    indicators: ['"Leveraged synergies" with no deliverable', 'Same phrase in 3 roles'],
  });
  const r = await aiGenerated.evaluate(ctx(provider));
  assert.equal(r.passed, false);
  assert.ok(Math.abs(r.score - 0.2) < 1e-12);
  assert.deepEqual(
    [...r.issues],
    [
      'AI giveaway: "Leveraged synergies" with no deliverable',
      'AI giveaway: Same phrase in 3 roles',
    ],
  );
  assert.equal(r.suggestions.length, 1);
});

test('ai: a score exactly at the threshold passes', async () => {
  const { provider } = fakeChat({ is_ai_generated: false, ai_probability: 0.6, indicators: [] });
  const r = await aiGenerated.evaluate(ctx(provider));
  assert.equal(r.score, 0.4);
  assert.equal(r.passed, true);
});

test('ai: the filter uses the score, not the is_ai_generated flag', async () => {
  // A quirk of the Python, kept for parity. The prompt sets the flag when the
  // probability is above 0.5, but the threshold fails only above 0.6. So a
  // probability of 0.55 sets the flag and still passes.
  const { provider } = fakeChat({ is_ai_generated: true, ai_probability: 0.55, indicators: [] });
  const r = await aiGenerated.evaluate(ctx(provider));
  assert.ok(Math.abs(r.score - 0.45) < 1e-12);
  assert.equal(r.passed, true, 'the flag says AI, the score says pass; the score wins');
});

test('ai: noShame halves the threshold', async () => {
  const base = loadConfig();
  const { provider } = fakeChat({ is_ai_generated: true, ai_probability: 0.75, indicators: [] });
  const strict = await aiGenerated.evaluate(ctx(provider));
  assert.equal(strict.passed, false, '0.25 fails a 0.4 threshold');

  const { provider: p2 } = fakeChat({
    is_ai_generated: true,
    ai_probability: 0.75,
    indicators: [],
  });
  const lenient = await aiGenerated.evaluate(ctx(p2, { config: { ...base, noShame: true } }));
  assert.equal(lenient.threshold, 0.2);
  assert.equal(lenient.passed, true, '0.25 clears a 0.2 threshold');
});

test('ai: the CV text is sent, and the system prompt carries the date', async () => {
  const { provider, seen } = fakeChat({
    is_ai_generated: false,
    ai_probability: 0.1,
    indicators: [],
  });
  await aiGenerated.evaluate(ctx(provider));
  assert.ok(seen[0]?.prompt.includes('RESUME TEXT'));
  assert.ok(seen[0]?.system?.startsWith(SYSTEM_PROMPT));
  assert.ok(seen[0]?.system?.includes(currentDateLine()));
});

test('ai: html is used when there is no pdfText', async () => {
  const { provider, seen } = fakeChat({
    is_ai_generated: false,
    ai_probability: 0.1,
    indicators: [],
  });
  await aiGenerated.evaluate(
    ctx(provider, {
      resume: {
        html: '<p>html</p>',
        pdfText: null,
        pngPage1: null,
        pageCount: 1,
        pageTexts: ['p'],
      },
    }),
  );
  assert.ok(seen[0]?.prompt.includes('<p>html</p>'));
});

test('ai: a provider failure propagates and does not become a pass', async () => {
  const provider: ChatProvider = {
    model: 'fake/model',
    complete: () => Promise.reject(new Error('unused')),
    object: () => Promise.reject(new Error('model unreachable')),
    supportsVision: () => false,
  };
  await assert.rejects(() => aiGenerated.evaluate(ctx(provider)), /model unreachable/);
});
