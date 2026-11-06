import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJdHeader } from '../src/jd-header.ts';

const RULE = '='.repeat(70);

const jd = (head: string, body = 'We build things with Node.js and TypeScript.'): string =>
  `${head}\n\n${RULE}\n\n${body}\n`;

test('parseJdHeader: reads the block the crawler writes', () => {
  const got = parseJdHeader(
    jd(
      'Senior Full-Stack Product Engineer\n' +
        'Shortstay Group\n' +
        'Remote worldwide except US/Canada\n' +
        'Salary: Not disclosed\n' +
        'Posted: 2026-09-23\n' +
        'Source: https://matcha.fm/job/1ff54572',
    ),
  );
  assert.deepEqual(got, {
    title: 'Senior Full-Stack Product Engineer',
    company: 'Shortstay Group',
    location: 'Remote worldwide except US/Canada',
  });
});

test('parseJdHeader: the employer wins over a product named all over the posting', () => {
  // The reason this file exists. The posting names its product eleven times and
  // the employer three, so the parser took the product for the company and the
  // CV was written under the product's name.
  const body = 'Northstar.ai is the AI operating system for short stays. '.repeat(11);
  const got = parseJdHeader(
    jd(
      'Senior Full-Stack Product Engineer\nShortstay Group\nRemote\nSalary: -\nPosted: 2026-09-23\nSource: https://x.test/1',
      body,
    ),
  );
  assert.equal(got?.company, 'Shortstay Group');
});

test('parseJdHeader: a posting with no header returns null, it does not guess', () => {
  // A hand-written or pasted posting must fall through to the parsed values.
  // Taking its first two lines as a title and a company would be worse than
  // reading the prose.
  assert.equal(
    parseJdHeader('We are hiring a Senior Engineer\n\nAbout us\n\nWe use Node.js.'),
    null,
  );
  assert.equal(parseJdHeader(''), null);
});

test('parseJdHeader: a rule far down the page is not a header', () => {
  const body = ['Line one', 'Line two', 'Line three'].join('\n').repeat(8);
  assert.equal(parseJdHeader(`${body}\n${RULE}\nmore text`), null);
});

test('parseJdHeader: the labelled lines are what prove it is a header', () => {
  // Three lines and a rule, but no Salary/Posted/Source: not the crawler's block.
  assert.equal(parseJdHeader(`A title\nA company\nA place\n\n${RULE}\n\nbody text here`), null);
  // Missing Source alone is enough to reject it.
  assert.equal(
    parseJdHeader(`A title\nA company\nA place\nSalary: -\nPosted: 2026-01-01\n\n${RULE}\n\nbody`),
    null,
  );
});

test('parseJdHeader: a missing location is null, not the Salary line', () => {
  const got = parseJdHeader(
    jd('Backend Engineer\nAcme\nSalary: 6000 EUR\nPosted: 2026-09-01\nSource: https://x.test/2'),
  );
  assert.equal(got?.company, 'Acme');
  assert.equal(got?.title, 'Backend Engineer');
  assert.equal(got?.location, null);
});
