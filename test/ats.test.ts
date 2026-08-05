import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SCORE_WEIGHTS, atsChecker, computeAtsScore } from '../src/filters/ats-checker.ts';
import type { AtsResult } from '../src/filters/ats-checker.ts';
import { SYSTEM_PROMPT, buildUserPrompt, currentDateLine } from '../src/prompts/ats.ts';
import { loadConfig } from '../src/config.ts';
import type { FilterContext } from '../src/filters/base.ts';
import type { EmbeddingProvider } from '../src/providers/embeddings.ts';
import type { ChatProviders } from '../src/providers/ai-sdk.ts';
import type { ChatProvider, ChatRequest } from '../src/providers/llm.ts';

const GOOD: AtsResult = {
  keyword_score: 0.8,
  experience_score: 0.9,
  education_score: 0.5,
  overall_fit_score: 0.85,
  disqualified: false,
  ats_issues: [],
};

const fakeChat = (reply: AtsResult) => {
  const seen: ChatRequest[] = [];
  const provider: ChatProvider = {
    model: 'fake/model',
    complete: () => Promise.reject(new Error('not used')),
    object: <T>(req: ChatRequest): Promise<T> => {
      seen.push(req);
      return Promise.resolve(reply as T);
    },
    // Deliberately false. The ATS half must work on a text-only provider.
    supportsVision: () => false,
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
    html: '<header class="header"><h1 class="name">J</h1></header>',
    pdfText: 'RESUME TEXT',
    pngPage1: null, // no image, on purpose
    pageCount: 1,
    pageTexts: ['p1'],
  },
  job: {
    title: 'Senior Node.js Engineer',
    company: 'Acme',
    description: 'Build things',
    rawText: 'Build things',
    requirements: ['Node.js', 'TypeScript'],
    keywords: ['AWS'],
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
    'a9e1d4186db491d7c96454526519ee0b0539dc6c8d8764213d0e4b077518003c',
  );
});

test('prompt: says nothing about layout, and never mentions an image', () => {
  // The whole point of the split. If this prompt starts asking about fonts and
  // spacing again, the two filters have merged back by accident.
  assert.ok(!/image/i.test(SYSTEM_PROMPT), 'no image');
  assert.ok(SYSTEM_PROMPT.includes('Do not comment on layout'), 'told to stay out of layout');
  assert.ok(!/looks_professional/.test(SYSTEM_PROMPT), 'no visual verdict field');
});

test('prompt: language note only for non-English', () => {
  const base = {
    jobTitle: 't',
    jobCompany: 'c',
    jobDescription: 'd',
    jobRequirements: [],
    jobKeywords: [],
    resumeText: 'r',
  };
  assert.ok(!buildUserPrompt({ ...base, languageCode: 'en' }).includes('LANGUAGE NOTE'));
  const pl = buildUserPrompt({ ...base, languageCode: 'pl' });
  assert.ok(pl.includes('=== LANGUAGE NOTE ==='));
  assert.ok(pl.includes('Polish'));
});

/* ---------- score ---------- */

test('ats: weights are the documented ones and sum to 1', () => {
  const sum =
    SCORE_WEIGHTS.keyword +
    SCORE_WEIGHTS.experience +
    SCORE_WEIGHTS.education +
    SCORE_WEIGHTS.overallFit;
  assert.ok(Math.abs(sum - 1) < 1e-12);
  assert.deepEqual(SCORE_WEIGHTS, {
    keyword: 0.25,
    experience: 0.175,
    education: 0.075,
    overallFit: 0.5,
  });
});

test('ats: overall_fit alone carries half the score', () => {
  const only = (f: Partial<AtsResult>): number =>
    computeAtsScore({
      ...GOOD,
      keyword_score: 0,
      experience_score: 0,
      education_score: 0,
      overall_fit_score: 0,
      ...f,
    });
  assert.ok(Math.abs(only({ overall_fit_score: 1 }) - 0.5) < 1e-12);
  assert.ok(Math.abs(only({ education_score: 1 }) - 0.075) < 1e-12);
});

/* ---------- filter ---------- */

test('ats: a strong match above threshold passes with its real score', async () => {
  const r = await atsChecker.evaluate(ctx(fakeChat(GOOD).provider));
  assert.equal(r.passed, true);
  assert.ok(Math.abs(r.score - computeAtsScore(GOOD)) < 1e-12);
  assert.equal(r.threshold, 0.7);
});

test('ats: runs on a provider with no vision support and needs no page image', async () => {
  const { provider, seen } = fakeChat(GOOD);
  const r = await atsChecker.evaluate(ctx(provider));
  assert.equal(r.passed, true, 'not skipped, not failed');
  assert.equal(seen[0]?.image, undefined, 'no image is ever sent');
});

test('ats: the score is NEVER zeroed out - a weak match is told apart from a defect', async () => {
  // The old combined filter multiplied the ATS score by a visual boolean, so a
  // dropped page image produced 0.00 and read exactly like a terrible CV. This
  // filter has no such lever: the score it reports is the score it computed.
  const weak: AtsResult = {
    ...GOOD,
    keyword_score: 0.2,
    experience_score: 0.2,
    education_score: 0.0,
    overall_fit_score: 0.3,
  };
  const r = await atsChecker.evaluate(ctx(fakeChat(weak).provider));
  assert.equal(r.passed, false);
  assert.ok(r.score > 0, 'a weak match still reports a real number');
  assert.ok(Math.abs(r.score - computeAtsScore(weak)) < 1e-12);
  assert.match(r.suggestions.join(' '), /Improve ATS match \(score: 0\.23, need: 0\.7\)/);
});

test('ats: disqualified fails even when the score clears the threshold', async () => {
  const r = await atsChecker.evaluate(ctx(fakeChat({ ...GOOD, disqualified: true }).provider));
  assert.equal(r.passed, false);
  assert.ok(r.score > 0.7, 'the score is still reported, only the verdict changes');
  assert.ok(r.suggestions.includes('Address disqualifying issues'));
});

test('ats: issues are surfaced verbatim', async () => {
  const { provider } = fakeChat({
    ...GOOD,
    ats_issues: ['Missing required skill: Redis', 'No education section'],
  });
  const r = await atsChecker.evaluate(ctx(provider));
  assert.deepEqual([...r.issues], ['Missing required skill: Redis', 'No education section']);
});

test('ats: the CV text and the job reach the model, with the date', async () => {
  const { provider, seen } = fakeChat(GOOD);
  await atsChecker.evaluate(ctx(provider));
  assert.ok(seen[0]?.prompt.includes('RESUME TEXT'));
  assert.ok(seen[0]?.prompt.includes('Senior Node.js Engineer'));
  assert.ok(seen[0]?.system?.startsWith(SYSTEM_PROMPT));
  assert.ok(seen[0]?.system?.includes(currentDateLine()));
});

test('ats: falls back to rawText when the parsed description is empty', async () => {
  const { provider, seen } = fakeChat(GOOD);
  await atsChecker.evaluate(
    ctx(provider, {
      job: {
        title: 't',
        company: 'c',
        description: '',
        rawText: 'THE WHOLE POSTING',
        requirements: [],
        keywords: [],
        language: 'en',
      },
    }),
  );
  assert.ok(seen[0]?.prompt.includes('THE WHOLE POSTING'));
});

test('ats: a provider failure propagates and does not become a pass', async () => {
  const provider: ChatProvider = {
    model: 'fake/model',
    complete: () => Promise.reject(new Error('unused')),
    object: () => Promise.reject(new Error('model unreachable')),
    supportsVision: () => false,
  };
  await assert.rejects(() => atsChecker.evaluate(ctx(provider)), /model unreachable/);
});
