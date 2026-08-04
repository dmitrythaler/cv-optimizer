import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

const PY = new URL('../../hr-breaker/src/hr_breaker/agents/optimizer.py', import.meta.url).pathname;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const grab = (name: string, raw: boolean): string => {
  const py = readFileSync(PY, 'utf8');
  const re = new RegExp(`${name}\\s*=\\s*${raw ? 'r' : ''}"""([\\s\\S]*?)"""`);
  const m = re.exec(py);
  assert.ok(m, `${name} found in the Python file`);
  return m[1] ?? '';
};

test('prompt: OPTIMIZER_BASE is identical to the Python', () => {
  assert.equal(sha(OPTIMIZER_BASE), sha(grab('OPTIMIZER_BASE', true)));
});

test('prompt: OPTIMIZER_STRICT_RULES is identical to the Python', () => {
  assert.equal(sha(OPTIMIZER_STRICT_RULES), sha(grab('OPTIMIZER_STRICT_RULES', false)));
});

test('prompt: OPTIMIZER_LENIENT_RULES is identical to the Python', () => {
  assert.equal(sha(OPTIMIZER_LENIENT_RULES), sha(grab('OPTIMIZER_LENIENT_RULES', false)));
});

test('prompt: resume_guide.md is identical to the Python copy', () => {
  const theirs = readFileSync(
    new URL('../../hr-breaker/templates/resume_guide.md', import.meta.url).pathname,
    'utf8',
  );
  assert.equal(sha(loadResumeGuide()), sha(theirs));
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
