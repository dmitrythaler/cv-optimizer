import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { SCORE_WEIGHTS, computeAtsScore, visionChecker } from '../src/filters/vision-checker.ts';
import type { VisionResult } from '../src/filters/vision-checker.ts';
import { SYSTEM_PROMPT, buildUserPrompt, currentDateLine } from '../src/prompts/vision.ts';
import { loadConfig } from '../src/config.ts';
import type { FilterContext } from '../src/filters/base.ts';
import type { EmbeddingProvider } from '../src/providers/embeddings.ts';
import type { ChatProviders } from '../src/providers/ai-sdk.ts';
import type { ChatProvider, ChatRequest } from '../src/providers/llm.ts';

const GOOD: VisionResult = {
  looks_professional: true,
  visual_issues: [],
  visual_feedback: '',
  keyword_score: 0.8,
  experience_score: 0.9,
  education_score: 0.5,
  overall_fit_score: 0.85,
  disqualified: false,
  ats_issues: [],
};

const fakeChat = (reply: VisionResult, opts: { vision?: boolean } = {}) => {
  const seen: ChatRequest[] = [];
  const provider: ChatProvider = {
    model: 'fake/model',
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
  dimensions: () => Promise.reject(new Error('stub embeddings: not expected to be called')),
  prefetch: () => Promise.reject(new Error('stub embeddings: not expected to be called')),
  embed: () => Promise.reject(new Error('stub embeddings: not expected to be called')),
  close: () => Promise.resolve(),
};

const trio = (p: ChatProvider): ChatProviders => ({ pro: p, flash: p, vision: p });

const ctx = (chat: ChatProvider, over: Partial<FilterContext> = {}): FilterContext => ({
  resume: {
    html: '<header class="header"><h1 class="name">D</h1></header>',
    pdfText: 'RESUME TEXT',
    pngPage1: new Uint8Array([137, 80, 78, 71]),
    pageCount: 1,
    pageTexts: ['p1'],
  },
  job: {
    title: 'Senior Node.js Engineer',
    company: 'Acme',
    description: 'Build things',
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

test('prompt: SYSTEM_PROMPT is byte-identical to the Python original', () => {
  const py = readFileSync(
    new URL('../../hr-breaker/src/hr_breaker/agents/combined_reviewer.py', import.meta.url),
    'utf8',
  );
  const want = /SYSTEM_PROMPT\s*=\s*"""([\s\S]*?)"""/.exec(py)?.[1];
  assert.ok(want, 'found SYSTEM_PROMPT in the Python source');
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  assert.equal(sha(SYSTEM_PROMPT), sha(want), 'prompt must not drift from hr-breaker');
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

/* ---------- ATS score ---------- */

test('ats: weights match combined_reviewer.py and sum to 1', () => {
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
  const only = (f: Partial<VisionResult>): number =>
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

test('vision: a professional CV above threshold passes with its ATS score', async () => {
  const { provider } = fakeChat(GOOD);
  const r = await visionChecker.evaluate(ctx(provider));
  assert.equal(r.passed, true);
  assert.ok(Math.abs(r.score - computeAtsScore(GOOD)) < 1e-12);
  assert.equal(r.threshold, 0.7);
});

test('vision: looks_professional=false forces score to exactly 0.00, discarding the ATS score', async () => {
  // This is the single most misread behaviour in hr-breaker. A 0.00 does NOT
  // mean the ATS rejected the CV - the ATS numbers here are excellent.
  const { provider } = fakeChat({ ...GOOD, looks_professional: false });
  const r = await visionChecker.evaluate(ctx(provider));
  assert.equal(r.score, 0.0);
  assert.equal(r.passed, false);
  assert.ok(computeAtsScore({ ...GOOD, looks_professional: false }) > 0.7, 'ATS half was fine');
});

test('vision: disqualified fails even when professional and above threshold', async () => {
  const { provider } = fakeChat({ ...GOOD, disqualified: true });
  const r = await visionChecker.evaluate(ctx(provider));
  assert.equal(r.passed, false);
  assert.ok(r.score > 0.7, 'score still reported, only the verdict changes');
  assert.ok(r.suggestions.includes('Address disqualifying issues'));
});

test('vision: professional but below threshold fails and says by how much', async () => {
  const weak: VisionResult = {
    ...GOOD,
    keyword_score: 0.2,
    experience_score: 0.2,
    education_score: 0.0,
    overall_fit_score: 0.3,
  };
  const r = await visionChecker.evaluate(ctx(fakeChat(weak).provider));
  assert.equal(r.passed, false);
  // 0.235, which both JS toFixed(2) and Python's .2f render as "0.23".
  assert.match(r.suggestions.join(' '), /Improve ATS match \(score: 0\.23, need: 0\.7\)/);
});

test('vision: score formatting agrees with Python except on exact binary ties', () => {
  // Both render 0.235 -> "0.23". They differ only where the value is an exact
  // tie in binary: Python rounds half-to-even (0.125 -> "0.12"), JS rounds
  // half-up (0.125 -> "0.13"). Display only - never reaches a verdict.
  assert.equal((0.235).toFixed(2), '0.23');
  assert.equal((2.675).toFixed(2), '2.67');
  assert.equal((0.125).toFixed(2), '0.13'); // Python would say 0.12
});

test('vision: visual and ATS issues are both surfaced', async () => {
  const { provider } = fakeChat({
    ...GOOD,
    looks_professional: false,
    visual_issues: ['text cut off'],
    ats_issues: ['missing required skill'],
  });
  const r = await visionChecker.evaluate(ctx(provider));
  assert.deepEqual([...r.issues], ['text cut off', 'missing required skill']);
  assert.ok(r.suggestions.includes('Fix visual/formatting issues'));
});

test('vision: the page image is actually sent to the model', async () => {
  const { provider, seen } = fakeChat(GOOD);
  await visionChecker.evaluate(ctx(provider));
  assert.ok(seen[0]?.image instanceof Uint8Array, 'image attached');
  assert.ok(seen[0]?.system?.startsWith(SYSTEM_PROMPT));
  assert.ok(seen[0]?.system?.includes(currentDateLine()));
});

test('vision: a provider without vision is SKIPPED, not judged', async () => {
  // hr-breaker had no such distinction - it returned looks_professional=false,
  // making a configuration fault indistinguishable from an ugly CV.
  const { provider, seen } = fakeChat(GOOD, { vision: false });
  const r = await visionChecker.evaluate(ctx(provider));
  assert.equal(seen.length, 0, 'no model call attempted');
  assert.match(r.issues[0] ?? '', /SKIPPED/);
  assert.ok(Number.isNaN(r.score), 'a skip has no score');
});

test('vision: a missing page image fails - that is a broken CV, not a config fault', async () => {
  const { provider, seen } = fakeChat(GOOD);
  const r = await visionChecker.evaluate(
    ctx(provider, {
      resume: {
        html: '<p/>',
        pdfText: 't',
        pngPage1: null,
        pageCount: 1,
        pageTexts: ['p'],
      },
    }),
  );
  assert.equal(seen.length, 0, 'no model call attempted');
  assert.equal(r.passed, false);
  assert.equal(r.score, 0.0);
  assert.deepEqual([...r.issues], ['No rendered page image available']);
});
