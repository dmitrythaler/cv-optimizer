import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractJobPostingLd } from '../src/job-ld.ts';

/**
 * The fixture holds the JSON-LD block of a REAL xing.com posting, fetched
 * 2026-08-05. It is in German, which is the point: the word-list cleaner in
 * job-text.ts speaks English and a little Polish, so a German page kept nearly
 * all of its junk. JSON-LD does not care what language the posting is in.
 */
const XING = readFileSync(new URL('./fixtures.xing-ld.html', import.meta.url).pathname, 'utf8');

test('json-ld: reads a German posting the word lists cannot touch', () => {
  const job = extractJobPostingLd(XING);
  assert.notEqual(job, null);
  assert.equal(job?.company, 'Stockert');
  assert.match(job?.title ?? '', /Backend Developer Fintech/);
  assert.ok((job?.descriptionChars ?? 0) > 2000, 'the whole description');
});

test('json-ld: the text carries the header the parser needs', () => {
  const job = extractJobPostingLd(XING);
  const text = job?.text ?? '';
  assert.match(text, /Backend Developer Fintech/);
  assert.match(text, /Stockert/);
  assert.match(text, /Hohenbrunn, Bayern, DE/);
  assert.match(text, /100000 EUR YEAR/);
});

test('json-ld: TELECOMMUTE is written as Remote', () => {
  const text = extractJobPostingLd(XING)?.text ?? '';
  assert.ok(text.includes('Remote'), 'readable');
  assert.ok(!text.includes('TELECOMMUTE'), 'not the raw schema token');
});

test('json-ld: drops the board\'s own stray "null" lines', () => {
  // xing.com ends its description with ten lines of the literal word "null".
  assert.match(XING, /null/, 'the fixture really does contain them');
  const text = extractJobPostingLd(XING)?.text ?? '';
  assert.ok(!text.split('\n').some((l) => l.trim() === 'null'), 'no bare null line survives');
});

test('json-ld: keeps the German content intact', () => {
  const text = extractJobPostingLd(XING)?.text ?? '';
  for (const line of [
    'Aufgaben',
    'Qualifikation',
    'Erfahrung mit Node.js, TypeScript oder vergleichbaren Backend-Technologien',
    'Sehr gute Deutsch- oder Englischkenntnisse',
  ]) {
    assert.ok(text.includes(line), `kept: ${line}`);
  }
});

test('json-ld: no navigation text reaches the result', () => {
  const text = extractJobPostingLd(XING)?.text ?? '';
  assert.ok(!text.includes('Navigationsmuell'), 'the page body is not used at all');
});

test('json-ld: returns null when the page has none', () => {
  assert.equal(extractJobPostingLd('<html><body><p>a job, but no markup</p></body></html>'), null);
});

test('json-ld: a broken block does not stop the next one', () => {
  const html =
    '<script type="application/ld+json">{ this is not json </script>' +
    `<script type="application/ld+json">${JSON.stringify({
      '@type': 'JobPosting',
      title: 'Senior Node Engineer',
      hiringOrganization: { name: 'Acme' },
      description: `<p>${'We need a backend engineer with real production experience. '.repeat(8)}</p>`,
    })}</script>`;
  const job = extractJobPostingLd(html);
  assert.equal(job?.company, 'Acme');
});

test('json-ld: finds a JobPosting nested in @graph', () => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', name: 'A board' },
      {
        '@type': ['JobPosting'],
        title: 'Platform Engineer',
        hiringOrganization: { name: 'Globex' },
        description: `<ul><li>${'Own services end to end and take part in on-call rotations. '.repeat(6)}</li></ul>`,
      },
    ],
  })}</script>`;
  assert.equal(extractJobPostingLd(html)?.company, 'Globex');
});

test('json-ld: ignores a stub description and lets the cleaner take over', () => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    '@type': 'JobPosting',
    title: 'Card teaser',
    description: 'Short summary.',
  })}</script>`;
  assert.equal(extractJobPostingLd(html), null);
});
