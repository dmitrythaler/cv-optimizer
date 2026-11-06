import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cleanJobText, describeClean } from '../src/job-text.ts';

/**
 * The fixture is a REAL page, fetched from justjoin.it on 2026-08-05 with the
 * tool's own plain-request path. 609 lines, of which the posting is lines
 * 96-250. Testing against invented junk would only prove the regexes match
 * themselves.
 */
const RAW = readFileSync(new URL('./fixtures.raw-jd.txt', import.meta.url).pathname, 'utf8');

test('clean: cuts the similar-offers trailer', () => {
  const { text, report } = cleanJobText(RAW);
  assert.equal(report.cutAt, 'Check similar offers');
  assert.ok(!text.includes('Check similar offers'), 'the heading itself is gone');
  assert.ok(!text.includes('ADVERTISEMENT'), 'the advert block is gone');
  assert.ok(!text.includes('© 2026 Just Join IT'), 'the footer is gone');
});

test('clean: keeps the whole posting body', () => {
  const { text } = cleanJobText(RAW);
  for (const line of [
    'Job description',
    'About the Role',
    'Responsibilities',
    'Requirements',
    'Nice to Have',
    'Develop and maintain modern web applications using React, Node.js, and TypeScript.',
    'Experience integrating with Headless CMS platforms, preferably Contentful.',
    'Strong understanding of accessibility standards (WCAG) and performance optimisation.',
    'Experience with authentication and identity platforms such as SAP Gigya.',
  ]) {
    assert.ok(text.includes(line), `kept: ${line}`);
  }
});

test('clean: keeps what the parser needs - title, company, salary', () => {
  const { text } = cleanJobText(RAW);
  assert.ok(text.includes('Beacon Group'), 'company');
  assert.ok(text.includes('Full-Stack Engineer'), 'title');
  assert.ok(text.includes('25,52 - 29,93 EUR Net per hour'), 'salary');
});

test('clean: drops navigation and legal boilerplate', () => {
  const { text } = cleanJobText(RAW);
  for (const junk of ['Show menu', 'Hide menu', 'Cookie settings', 'Add offer']) {
    assert.ok(!text.split('\n').includes(junk), `dropped: ${junk}`);
  }
  assert.ok(!text.includes('protected by reCAPTCHA'), 'recaptcha notice dropped');
  assert.ok(!text.includes('consent to the processing'), 'consent notice dropped');
});

test('clean: removes more than half of the page', () => {
  const { report } = cleanJobText(RAW);
  assert.equal(report.charsBefore, RAW.length);
  assert.ok(report.charsAfter < RAW.length * 0.55, `kept ${report.charsAfter} of ${RAW.length}`);
  assert.ok(report.charsAfter > 2000, 'but the posting itself survived');
  assert.equal(report.keptRaw, false);
});

test('clean: a trailer word near the top cannot truncate the page', () => {
  // "All offers" sits in the navigation at line 64. A rule that fired there
  // would throw the whole posting away.
  const { text } = cleanJobText(RAW);
  assert.ok(text.includes('Nice to Have'), 'content after the nav survived');
});

test('clean: refuses to destroy a page it does not understand', () => {
  // Every line looks like navigation, so the rules would leave almost nothing.
  const allJunk = `${Array(60).fill('Apply\nSave\nLog in').join('\n')}\n`;
  const { text, report } = cleanJobText(allJunk);
  assert.equal(report.keptRaw, true);
  assert.equal(text, allJunk.trim());
  assert.match(describeClean(report), /REFUSED/);
});

test('clean: leaves an already clean posting alone', () => {
  const clean = [
    'Senior Node.js Engineer at Acme',
    '',
    'Requirements',
    'Five years of TypeScript.',
    'Experience with PostgreSQL and Redis in production systems.',
    'You will own services end to end and take part in on-call.',
  ].join('\n');
  const { text, report } = cleanJobText(`${clean}\n${'Filler sentence for length. '.repeat(20)}`);
  assert.equal(report.cutAt, null);
  assert.ok(text.startsWith('Senior Node.js Engineer at Acme'));
  assert.ok(text.includes('Experience with PostgreSQL and Redis in production systems.'));
});

test('describeClean: says what it did', () => {
  const { report } = cleanJobText(RAW);
  const line = describeClean(report);
  assert.match(line, new RegExp(`${RAW.length} -> \\d+ chars`));
  assert.match(line, /cut at "Check similar offers"/);
});
