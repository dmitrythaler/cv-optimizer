import { test } from 'node:test';
import assert from 'node:assert/strict';
import { optimize } from '../src/pipeline/orchestrator.ts';
import { register, all, runAll } from '../src/filters/registry.ts';
import { ProviderUnavailableError, providerFault } from '../src/providers/provider-error.ts';
import { loadConfig } from '../src/config.ts';
import type { FilterContext } from '../src/filters/base.ts';
import type { Config } from '../src/config.ts';
import type { Generator, OptimizeDeps } from '../src/pipeline/orchestrator.ts';
import type { Renderer } from '../src/render/pdf.ts';
import type { ChatProviders } from '../src/providers/ai-sdk.ts';
import type { ChatProvider } from '../src/providers/llm.ts';
import type { EmbeddingProvider } from '../src/providers/embeddings.ts';
import type { FilterResult, JobPosting, ResumeSource } from '../src/types.ts';

const stubChat: ChatProvider = {
  model: 'stub/none',
  complete: () => Promise.reject(new Error('unused')),
  object: () => Promise.reject(new Error('unused')),
  supportsVision: () => false,
};
const chat: ChatProviders = { pro: stubChat, flash: stubChat, vision: stubChat };
const embeddings: EmbeddingProvider = {
  model: 'stub/none',
  dimensions: () => Promise.reject(new Error('unused')),
  prefetch: () => Promise.reject(new Error('unused')),
  embed: () => Promise.reject(new Error('unused')),
  close: () => Promise.resolve(),
};

const SOURCE: ResumeSource = { text: 'CV', path: 'cv.md', instructions: null };
const JOB: JobPosting = {
  title: 'T',
  company: 'C',
  description: 'D',
  rawText: 'D',
  requirements: [],
  keywords: [],
  language: 'en',
};

/** Renders anything to a one-page document. */
const fakeRenderer = (opts: { fail?: boolean } = {}): Renderer => ({
  render: (html) =>
    opts.fail === true
      ? Promise.reject(new Error('render exploded'))
      : Promise.resolve({
          pdf: new Uint8Array([37, 80, 68, 70]),
          text: `TEXT:${html}`,
          pngPage1: new Uint8Array([137, 80, 78, 71]),
          pageCount: 1,
          pageTexts: [`TEXT:${html}`],
        }),
  close: () => Promise.resolve(),
});

/** Returns a numbered CV, and records what feedback it was given. */
const fakeGenerator = (): { gen: Generator; seen: { iteration: number; feedback: string[] }[] } => {
  const seen: { iteration: number; feedback: string[] }[] = [];
  const gen: Generator = (input) => {
    seen.push({
      iteration: input.iteration,
      feedback: input.filterResults.map((r) => r.filterName),
    });
    return Promise.resolve({
      markdown: `<p>attempt ${input.iteration}</p>`,
      pdfText: null,
      pngPage1: null,
      pageCount: null,
      pageTexts: null,
    });
  };
  return { gen, seen };
};

const cfg = (over: Partial<Config> = {}): Config => ({ ...loadConfig(), ...over });

const deps = (over: Partial<OptimizeDeps> = {}): OptimizeDeps => ({
  generate: fakeGenerator().gen,
  renderer: fakeRenderer(),
  chat,
  embeddings,
  config: cfg({ maxIterations: 3 }),
  ...over,
});

/* The registry is global, so each test installs the filters it needs under a
   unique name and they accumulate. Tests assert on their own filter only. */
let n = 0;
const installFilter = (results: boolean[]): string => {
  const name = `T${++n}`;
  let call = 0;
  register({
    name,
    priority: 50 + n,
    evaluate: (): Promise<FilterResult> => {
      const passed = results[Math.min(call, results.length - 1)] ?? true;
      call++;
      return Promise.resolve({
        filterName: name,
        passed,
        score: passed ? 1 : 0,
        threshold: 1,
        issues: passed ? [] : ['nope'],
        suggestions: [],
      });
    },
  });
  return name;
};

const only = (r: readonly FilterResult[], name: string): FilterResult | undefined =>
  r.find((x) => x.filterName === name);

test('optimize: stops at the first fully passing iteration', async () => {
  const name = installFilter([true]);
  const { gen, seen } = fakeGenerator();
  const out = await optimize(SOURCE, JOB, deps({ generate: gen }));
  assert.equal(seen.length, 1, 'one generation only');
  assert.equal(out.iterations.length, 1);
  assert.equal(only(out.filed.results, name)?.passed, true);
});

test('optimize: retries up to the budget when a filter keeps failing', async () => {
  installFilter([false]);
  const { gen, seen } = fakeGenerator();
  const out = await optimize(SOURCE, JOB, deps({ generate: gen }));
  assert.equal(seen.length, 3, 'used the whole budget');
  assert.equal(out.iterations.length, 3);
  assert.equal(out.passed, false);
});

test('optimize: feeds the previous failures back to the generator', async () => {
  const name = installFilter([false, true]);
  const { gen, seen } = fakeGenerator();
  await optimize(SOURCE, JOB, deps({ generate: gen }));
  assert.deepEqual(seen[0]?.feedback, [], 'first attempt gets no feedback');
  assert.ok(seen[1]?.feedback.includes(name), 'second attempt is told what failed');
});

test('optimize: files the LAST iteration, not the best one', async () => {
  // The loop returns the last attempt. It does not choose. Every iteration
  // is returned so a caller can look back.
  installFilter([false]);
  const out = await optimize(SOURCE, JOB, deps());
  assert.equal(out.filed, out.iterations[out.iterations.length - 1]);
  assert.equal(out.filed.n, 3);
});

test('optimize: grades the rendered text, not the html', async () => {
  let sawText: string | null = null;
  const name = `T${++n}`;
  register({
    name,
    priority: 60 + n,
    evaluate: (ctx) => {
      sawText = ctx.resume.pdfText;
      return Promise.resolve({
        filterName: name,
        passed: true,
        score: 1,
        threshold: 1,
        issues: [],
        suggestions: [],
      });
    },
  });
  await optimize(SOURCE, JOB, deps());
  assert.match(sawText ?? '', /^TEXT:/, 'the filter saw text extracted from the PDF');
});

test('optimize: a render failure becomes a PDFRender result and does not throw', async () => {
  const out = await optimize(
    SOURCE,
    JOB,
    deps({ renderer: fakeRenderer({ fail: true }), config: cfg({ maxIterations: 2 }) }),
  );
  assert.equal(out.passed, false);
  assert.equal(out.filed.results[0]?.filterName, 'PDFRender');
  assert.equal(out.iterations.length, 2, 'it kept trying');
});

test('optimize: a generator failure ends the run cleanly', async () => {
  const failing: Generator = () => Promise.reject(new Error('did not converge'));
  const out = await optimize(SOURCE, JOB, deps({ generate: failing }));
  assert.equal(out.passed, false);
  assert.equal(out.filed.results[0]?.filterName, 'Optimizer');
  assert.match(out.filed.results[0]?.issues[0] ?? '', /did not converge/);
});

test('optimize: reports which filters failed', async () => {
  const name = installFilter([false]);
  const out = await optimize(SOURCE, JOB, deps({ config: cfg({ maxIterations: 1 }) }));
  assert.ok(out.failedFilters.includes(name));
});

/* ---------- runAll ---------- */

test('runAll: a filter that throws becomes a FAILURE, never a pass', async () => {
  // A throw is a bug in the filter. A bug must not read as approval. This is
  // different from skipped(), which a filter returns on purpose.
  const name = `T${++n}`;
  register({
    name,
    priority: 70 + n,
    evaluate: () => Promise.reject(new Error('boom')),
  });
  const results = await runAll({
    resume: { markdown: '', pdfText: '', pngPage1: null, pageCount: 1, pageTexts: [''] },
    job: JOB,
    source: SOURCE,
    config: cfg(),
    chat,
    embeddings,
    targetLanguage: 'en',
  });
  const r = only(results, name);
  assert.equal(r?.passed, false);
  assert.equal(r?.score, 0);
  assert.match(r?.issues[0] ?? '', /Filter error: Error: boom/);
});

/* ---------- provider faults ---------- */

/** The real Gemini body, word for word, from the batch of 2026-11-05. */
const DEPLETED =
  'Your prepayment credits are depleted. Please go to AI Studio at ' +
  'https://ai.studio/projects to manage your project and billing.';

const apiError = (message: string, statusCode?: number): Error => {
  const err = new Error(message);
  err.name = 'AI_APICallError';
  if (statusCode !== undefined) Object.assign(err, { statusCode });
  return err;
};

const bareCtx = (): FilterContext => ({
  resume: { markdown: '', pdfText: '', pngPage1: null, pageCount: 1, pageTexts: [''] },
  job: JOB,
  source: SOURCE,
  config: cfg(),
  chat,
  embeddings,
  targetLanguage: 'en',
});

test('providerFault: names the fault for a provider error, null for a filter bug', () => {
  assert.match(providerFault(apiError(DEPLETED)) ?? '', /prepay balance is empty/);
  assert.match(providerFault(apiError('nope', 402)) ?? '', /HTTP 402/);
  assert.match(providerFault(apiError('nope', 401)) ?? '', /credentials/);
  assert.match(providerFault(apiError('API key not valid')) ?? '', /API key/);
  assert.match(providerFault(apiError('You exceeded your current quota')) ?? '', /quota/);
  // A bug in the filter is not a provider fault, and must stay a FAILURE.
  assert.equal(providerFault(new Error('boom')), null);
  assert.equal(providerFault(new TypeError('x is not a function')), null);
  assert.equal(providerFault(apiError('model produced invalid JSON', 500)), null);
});

test('providerFault: CV wording cannot fake a provider fault', () => {
  // A Zod error echoes the model's own output, so CV text reaches the
  // classifier. A bullet about a billing system must not end the run.
  const echoed =
    'Invalid JSON response: {"summary":"Built the billing and rate limit layer ' +
    'for a payments platform; cut quota overruns and credit card declines."}';
  assert.equal(providerFault(new Error(echoed)), null);
  assert.equal(providerFault(apiError(echoed, 422)), null);
});

test('providerFault: reads the whole cause chain', () => {
  const inner = apiError(DEPLETED);
  const outer = new Error('vision call failed', { cause: inner });
  assert.match(providerFault(outer) ?? '', /prepay balance is empty/);
});

/* The registry is global and cannot be emptied, so the provider tests share
   ONE filter. It runs first, which matters: sequential mode stops at the first
   failure, and the tests above leave failing filters behind. It passes while
   `providerError` is null, so it disturbs nothing else. */
const PROVIDER = 'TProvider';
let providerError: Error | null = null;
let providerCalls = 0;
register({
  name: PROVIDER,
  priority: -1,
  evaluate: () => {
    providerCalls++;
    if (providerError !== null) return Promise.reject(providerError);
    return Promise.resolve({
      filterName: PROVIDER,
      passed: true,
      score: 1,
      threshold: 1,
      issues: [],
      suggestions: [],
    });
  },
});
const withProviderError = (err: Error): void => {
  providerError = err;
  providerCalls = 0;
};

test('runAll: a provider fault ENDS the run, it does not fail the CV', async () => {
  // MEASURED 2026-11-05: an empty wallet made this throw on every call, every
  // throw read as "the CV is broken", so no iteration could pass and the loop
  // spent its whole budget on CVs it could not grade.
  withProviderError(apiError(DEPLETED));
  await assert.rejects(() => runAll(bareCtx()), ProviderUnavailableError);
  await assert.rejects(() => runAll(bareCtx(), { sequential: true }), ProviderUnavailableError);
  providerError = null;
});

test('ProviderUnavailableError: says which filter and that nothing was graded', async () => {
  withProviderError(apiError('nope', 402));
  await assert.rejects(
    () => runAll(bareCtx()),
    (err: unknown) => {
      assert.ok(err instanceof ProviderUnavailableError);
      assert.equal(err.filterName, PROVIDER);
      assert.match(err.message, /was NOT graded/);
      return true;
    },
  );
  providerError = null;
});

test('optimize: a provider fault stops the loop instead of buying iterations', async () => {
  withProviderError(apiError(DEPLETED));
  const { gen, seen } = fakeGenerator();
  await assert.rejects(
    () => optimize(SOURCE, JOB, deps({ generate: gen, config: cfg({ maxIterations: 3 }) })),
    ProviderUnavailableError,
  );
  assert.equal(providerCalls, 1, 'the filter was asked once, not three times');
  assert.equal(seen.length, 1, 'no second CV was generated and paid for');
  providerError = null;
});

test('optimize: a provider fault in the GENERATOR is not called non-convergence', async () => {
  const failing: Generator = () => Promise.reject(apiError(DEPLETED));
  await assert.rejects(
    () => optimize(SOURCE, JOB, deps({ generate: failing })),
    (err: unknown) => {
      assert.ok(err instanceof ProviderUnavailableError);
      assert.match(err.message, /prepay balance is empty/);
      return true;
    },
  );
});

test('registry: every implemented filter is registered', async () => {
  const { all: allFilters } = await import('../src/filters/index.ts');
  const names = allFilters().map((f) => f.name);
  for (const expected of [
    'ContentLengthChecker',
    'DataValidator',
    'HallucinationChecker',
    'KeywordMatcher',
    'AtsChecker',
    'VectorSimilarityMatcher',
    'AiGeneratedChecker',
  ]) {
    assert.ok(names.includes(expected), `${expected} registered`);
  }
  assert.equal(all().length, allFilters().length, 'same registry');
});
