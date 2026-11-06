import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SYSTEM_PROMPT } from '../src/prompts/job-parser.ts';
import { parseJobPosting } from '../src/job.ts';
import { htmlToText } from '../src/fetch-job.ts';
import { naming, renderCvName, runFolderName, sanitize, stamp } from '../src/output-path.ts';
import type { ChatProvider, ChatRequest } from '../src/providers/llm.ts';

test('prompt: the job parser system prompt has not drifted', () => {
  assert.equal(
    createHash('sha256').update(SYSTEM_PROMPT).digest('hex'),
    '073acaac3fcdd7eabdebde14480e6c3eb6523d69c686811e02da7a62e646da36',
  );
});

test('parseJobPosting: keeps the summary and the full text apart', async () => {
  // `description` holds the model's brief summary and `rawText` the whole
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

test('naming: run folder is {date}-{time}-{company}-{position}', () => {
  const n = naming(
    'well.made Talents',
    'Senior Full Stack Developer (Node.js+React)',
    'en',
    stamp(new Date(2026, 7, 5, 9, 12)),
  );
  assert.equal(
    runFolderName(n),
    '20260805-0912-well_made_talents-senior_full_stack_developer_node_js_react',
  );
});

test('naming: run folder drops a missing position, never the company', () => {
  const n = naming('Acme Inc', null, null, stamp(new Date(2026, 7, 5, 9, 12)));
  assert.equal(runFolderName(n), '20260805-0912-acme_inc');
});

test('naming: stamp is YYYYMMDD and HHMM', () => {
  assert.deepEqual(stamp(new Date(2026, 7, 4, 9, 5)), { date: '20260804', time: '0905' });
});

test('naming: sanitize collapses runs and trims edges', () => {
  assert.equal(sanitize('  Node.js / React!! '), 'node_js_react');
});

/* ---------- CV_NAME_TEMPLATE ---------- */

const NAMED = naming(
  'Beacon Group',
  'Full-Stack Engineer',
  'en',
  stamp(new Date(2026, 7, 5, 9, 12)),
);

test('template: fills every documented placeholder', () => {
  assert.equal(
    renderCvName('{date}_{time}_{company}_{position}_{lang}.pdf', NAMED),
    '20260805_0912_beacon_group_full_stack_engineer_en.pdf',
  );
});

test('template: static text is kept as written', () => {
  assert.equal(
    renderCvName('John.Dow.CV.{company}.{position}.pdf', NAMED),
    'John.Dow.CV.beacon_group.full_stack_engineer.pdf',
  );
});

test('template: _slug aliases mean the same thing', () => {
  assert.equal(
    renderCvName('{company_slug}-{position_slug}.pdf', NAMED),
    renderCvName('{company}-{position}.pdf', NAMED),
  );
});

test('template: .pdf is appended when missing', () => {
  assert.equal(renderCvName('CV.{company}', NAMED), 'CV.beacon_group.pdf');
});

test('template: an unknown placeholder throws, it does not ship as text', () => {
  assert.throws(() => renderCvName('CV.{compnay}.pdf', NAMED), /unknown placeholder/i);
});

test('template: an empty position leaves no doubled separator', () => {
  const n = naming('Acme', null, 'en', stamp(new Date(2026, 7, 5, 9, 12)));
  assert.equal(renderCvName('CV.{company}.{position}.pdf', n), 'CV.acme.pdf');
});

test('template: a path separator cannot escape the run folder', () => {
  assert.ok(!renderCvName('../../{company}.pdf', NAMED).includes('/'));
});

test('template: a template that renders to nothing throws', () => {
  const n = naming('', null, 'en', stamp());
  assert.throws(() => renderCvName('{position}.pdf', n), /empty file name/i);
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
