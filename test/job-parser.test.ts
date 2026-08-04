import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { SYSTEM_PROMPT, buildUserPrompt } from '../src/prompts/job-parser.ts';
import { parseJobPosting } from '../src/job.ts';
import { htmlToText } from '../src/fetch-job.ts';
import { debugDirName, pdfName, runId, sanitize } from '../src/output-path.ts';
import type { ChatProvider, ChatRequest } from '../src/providers/llm.ts';

test('prompt: the job parser prompt is identical to the Python', () => {
  const py = readFileSync(
    new URL('../../hr-breaker/src/hr_breaker/agents/job_parser.py', import.meta.url).pathname,
    'utf8',
  );
  const want = /SYSTEM_PROMPT\s*=\s*"""([\s\S]*?)"""/.exec(py)?.[1];
  assert.ok(want);
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  assert.equal(sha(SYSTEM_PROMPT), sha(want));
  assert.equal(buildUserPrompt('X'), 'Parse this job posting:\n\nX');
});

test('parseJobPosting: keeps the summary and the full text apart', async () => {
  // The Python stores the model's brief summary in `description` and the whole
  // posting in `raw_text`. KeywordMatcher scores against the summary.
  const seen: ChatRequest[] = [];
  const chat: ChatProvider = {
    model: 'fake/model',
    complete: () => Promise.reject(new Error('unused')),
    object: <T>(req: ChatRequest): Promise<T> => {
      seen.push(req);
      return Promise.resolve({
        title: 'Senior Node.js Engineer',
        company: 'Acme',
        requirements: ['Node.js'],
        keywords: ['AWS'],
        language_code: 'pl',
        description: 'Short summary.',
      } as T);
    },
    supportsVision: () => false,
  };
  const full = 'THE WHOLE POSTING, which is much longer than the summary.';
  const job = await parseJobPosting(full, chat);
  assert.equal(job.description, 'Short summary.');
  assert.equal(job.rawText, full);
  assert.equal(job.title, 'Senior Node.js Engineer');
  assert.equal(job.language, 'pl');
  assert.ok(seen[0]?.prompt.includes(full));
});

/* ---------- output naming ---------- */

test('naming: matches hr-breaker pdf_storage', () => {
  assert.equal(
    pdfName({
      firstName: 'Dmitry',
      lastName: 'Thaler',
      company: 'co.brick Talents',
      role: 'Senior Full Stack Developer (Node.js+React)',
      langCode: 'en',
      runId: '0804_1530',
    }),
    '0804_1530_dmitry_thaler_co_brick_talents_senior_full_stack_developer_node_js_react_en.pdf',
  );
});

test('naming: language always appended, defaulting to en', () => {
  assert.match(
    pdfName({
      firstName: null,
      lastName: null,
      company: 'X',
      role: null,
      langCode: null,
      runId: null,
    }),
    /^x_en\.pdf$/,
  );
  assert.match(
    pdfName({
      firstName: null,
      lastName: null,
      company: 'X',
      role: null,
      langCode: 'pl',
      runId: null,
    }),
    /^x_pl\.pdf$/,
  );
});

test('naming: debug directory matches hr-breaker', () => {
  assert.equal(
    debugDirName('Acme Inc', 'Senior Dev', '0804_1530'),
    '0804_1530_debug_acme_inc_senior_dev',
  );
});

test('naming: sanitize collapses runs and trims edges', () => {
  assert.equal(sanitize('  Node.js / React!! '), 'node_js_react');
});

test('naming: runId is MMDD_HHMM', () => {
  assert.equal(runId(new Date(2026, 7, 4, 9, 5)), '0804_0905');
});

/* ---------- html to text ---------- */

test('htmlToText: strips scripts, styles and markup', () => {
  const html =
    '<html><head><style>a{}</style></head><body><script>x()</script>' +
    '<h1>Title</h1><p>One&nbsp;two</p><ul><li>Item</li></ul></body></html>';
  const text = htmlToText(html);
  assert.ok(!text.includes('x()'), 'script gone');
  assert.ok(!text.includes('a{}'), 'style gone');
  assert.ok(text.includes('Title'));
  assert.ok(text.includes('One two'), 'entities decoded');
  assert.ok(text.includes('Item'));
});

test('htmlToText: keeps block structure as newlines', () => {
  assert.equal(htmlToText('<p>a</p><p>b</p>'), 'a\nb');
});
