import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  OPTIMIZER_BASE,
  OPTIMIZER_LENIENT_RULES,
  OPTIMIZER_STRICT_RULES,
  buildSystemPrompt,
  buildUserPrompt,
  formatFilterResults,
  loadResumeGuide,
} from '../src/prompts/optimizer.ts';
import { estimateLength } from '../src/generator.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Locked prompt digests.
 *
 * A prompt is behaviour. Changing one silently changes what every filter and
 * the generator do, and nothing about a passing run says so. A formatter once
 * rewrote two prompt files by itself; this is what caught it.
 *
 * If a digest here fails, that is the point. Change it only when the prompt
 * change is deliberate, and say so in the commit message.
 */
const LOCKED = {
  OPTIMIZER_BASE: 'e0282fb56dfca66a1a99209c41725797c887bd509bc1e627f486f58c35468931',
  OPTIMIZER_STRICT_RULES: '354673898f7e9e7f9a6fc93dc9ad4fe91bf51ac07553c1f11a2f22a42e25dee0',
  OPTIMIZER_LENIENT_RULES: 'd18304032285b6a2f502bb7546f8c634060d493be145251718561a93bb2b4949',
  RESUME_GUIDE: '47082e39ab4ad539176fb1dbebb088365d4793b95824d4c91e6cd57c651426fd',
};

test('prompt: OPTIMIZER_BASE has not drifted', () => {
  assert.equal(sha(OPTIMIZER_BASE), LOCKED.OPTIMIZER_BASE);
});

test('prompt: OPTIMIZER_STRICT_RULES has not drifted', () => {
  assert.equal(sha(OPTIMIZER_STRICT_RULES), LOCKED.OPTIMIZER_STRICT_RULES);
});

test('prompt: OPTIMIZER_LENIENT_RULES has not drifted', () => {
  assert.equal(sha(OPTIMIZER_LENIENT_RULES), LOCKED.OPTIMIZER_LENIENT_RULES);
});

test('prompt: resume_guide.md has not drifted', () => {
  assert.equal(sha(loadResumeGuide()), LOCKED.RESUME_GUIDE);
});

test('prompt: the system prompt fills both slots and picks rules by mode', () => {
  const strict = buildSystemPrompt({ noShame: false });
  assert.ok(!strict.includes('{content_rules}'), 'no unfilled slot');
  assert.ok(!strict.includes('{resume_guide}'), 'no unfilled slot');
  assert.ok(strict.includes('NEVER add specific named products'), 'strict rules present');
  assert.ok(strict.includes(loadResumeGuide().slice(0, 60)), 'guide pasted in');

  const lenient = buildSystemPrompt({ noShame: true });
  assert.ok(lenient.includes('You CAN extrapolate skills'), 'lenient rules present');
  assert.ok(!lenient.includes('NEVER add specific named products'), 'strict rules gone');
});

test('prompt: optional blocks appear only when they have content', () => {
  const base = {
    originalResume: 'CV',
    jobTitle: 'T',
    jobCompany: 'C',
    jobRequirements: [],
    jobKeywords: [],
    jobDescription: 'D',
    userInstructions: null,
    languageCode: 'en',
    lastAttempt: null,
    iteration: 1,
    lastAttemptChars: 0,
    lastAttemptWords: 0,
    filterResults: [],
  };
  const first = buildUserPrompt(base);
  assert.ok(!first.includes('## User Instructions'));
  assert.ok(!first.includes('## TARGET LANGUAGE'));
  assert.ok(!first.includes('## Last Attempt'));
  assert.ok(!first.includes('## Filter Results'));
  assert.ok(first.includes('Output ONLY valid JSON'));

  const full = buildUserPrompt({
    ...base,
    userInstructions: 'do not change 15+ years',
    languageCode: 'pl',
    lastAttempt: '<p>old</p>',
    iteration: 2,
    lastAttemptChars: 10,
    lastAttemptWords: 2,
    filterResults: [
      {
        filterName: 'KeywordMatcher',
        passed: false,
        score: 0.2,
        threshold: 0.25,
        issues: ['Missing important keywords: nomad'],
        suggestions: ['Add missing keywords'],
      },
    ],
  });
  assert.ok(full.includes('do not change 15+ years'));
  assert.ok(full.includes('## TARGET LANGUAGE: Polish'));
  assert.ok(full.includes('## Last Attempt (Iteration 2)'));
  assert.ok(full.includes('[KeywordMatcher] Score: 0.20/0.25 (FAILED)'));
  assert.ok(full.includes('  Issue: Missing important keywords: nomad'));
});

test('prompt: filter report leaves skipped filters out', () => {
  const text = formatFilterResults([
    {
      filterName: 'A',
      passed: true,
      score: 1,
      threshold: 0.5,
      issues: [],
      suggestions: [],
    },
    {
      filterName: 'Skipped',
      passed: true,
      score: Number.NaN,
      threshold: 0.5,
      issues: ['SKIPPED'],
      suggestions: [],
      skipped: true,
    },
  ]);
  assert.ok(text.includes('[A] Score: 1.00/0.50 (PASSED)'));
  assert.ok(!text.includes('Skipped'), 'a skipped filter must not reach the prompt');
});

test('estimateLength: strips tags and collapses whitespace', () => {
  assert.deepEqual(estimateLength('<p>one   two</p>\n<b>three</b>'), {
    chars: 13,
    words: 3,
  });
  assert.deepEqual(estimateLength(''), { chars: 0, words: 0 });
});
