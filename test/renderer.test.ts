import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { playwrightRenderer, wrapHtml } from '../src/render/playwright.ts';

/**
 * Exercises the real renderer: Chromium makes a PDF, poppler reads it back.
 *
 * Skipped when Chromium or poppler is missing, so a bare checkout does not
 * fail. One renderer is shared, because a browser launch costs about 200 ms.
 */
const has = (tool: string): boolean => {
  try {
    execFileSync(tool, ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
let chromiumOk = true;
try {
  const { chromium } = await import('playwright');
  chromiumOk = chromium.executablePath().length > 0;
} catch {
  chromiumOk = false;
}
const ready = chromiumOk && has('pdftotext') && has('pdftoppm');
const opts = ready ? {} : { skip: 'needs chromium and poppler-utils' };

const renderer = playwrightRenderer();
after(() => renderer.close());

const HEADER = '<header class="header"><h1 class="name">Dmitry Thaler</h1></header>';
const SECTION =
  '<section class="section"><h2 class="section-title">SUMMARY</h2><p>Node.js.</p></section>';

test('wrapHtml: fills both template placeholders', () => {
  const out = wrapHtml('<body>{{HEADER}}|{{BODY}}</body>', '<p>x</p>');
  assert.equal(out, '<body>|<p>x</p></body>');
});

test('renderer: produces a PDF, a page count and page text', opts, async () => {
  const out = await renderer.render(HEADER + SECTION);
  assert.ok(out.pdf.length > 1000, 'a real PDF');
  assert.equal(String.fromCharCode(...out.pdf.slice(0, 4)), '%PDF');
  assert.equal(out.pageCount, 1);
  assert.equal(out.pageTexts.length, 1);
  assert.match(out.pageTexts[0] ?? '', /SUMMARY/);
  assert.match(out.text, /Node\.js/);
});

test('renderer: page one image is a real PNG', opts, async () => {
  const out = await renderer.render(HEADER + SECTION);
  assert.deepEqual([...out.pngPage1.slice(0, 4)], [137, 80, 78, 71], 'PNG magic bytes');
  assert.ok(out.pngPage1.length > 5000, 'not an empty image');
});

test('renderer: counts pages from the real PDF, not from a guess', opts, async () => {
  const long = SECTION + '<p>filler line.</p>'.repeat(400);
  const out = await renderer.render(HEADER + long);
  assert.ok(out.pageCount > 1, `expected several pages, got ${out.pageCount}`);
  assert.equal(out.pageTexts.length, out.pageCount, 'one text block per page');
  // Page two must hold its own text. ContentLengthChecker reads exactly this
  // to tell a real second page from a stray overflow line.
  assert.ok((out.pageTexts[1] ?? '').trim().length > 0);
});

test('renderer: letter-spacing above 1.2pt breaks name extraction', opts, async () => {
  // Chromium bakes CSS letter-spacing into wide glyph gaps, and every PDF text
  // extractor then inserts spaces - including the one a real ATS would use.
  // WeasyPrint did not do this, so the behaviour is new. The template ships
  // 2pt on .name. See docs/porting-notes.md.
  const at = async (ls: string): Promise<string> => {
    const out = await renderer.render(
      `<header class="header"><h1 class="name" style="letter-spacing:${ls}">Dmitry Thaler</h1></header>${SECTION}`,
    );
    return (out.pageTexts[0] ?? '').trim().split('\n')[0] ?? '';
  };
  assert.equal(await at('1.2pt'), 'DMITRY THALER', 'parses at 1.2pt');
  assert.notEqual(await at('2pt'), 'DMITRY THALER', 'breaks at 2pt, the template default');
});
