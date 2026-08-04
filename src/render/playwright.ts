import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import type { RenderOutput, Renderer } from './pdf.ts';

const run = promisify(execFile);

/**
 * Renders resume HTML to PDF, then reads the real PDF back.
 *
 * hr-breaker used WeasyPrint. This port uses Chromium through Playwright,
 * which gives a real CSS engine and is already a dependency of the parent
 * project.
 *
 * The page count, the per-page text and the page image all come from the
 * PRODUCED PDF, through poppler. They are never guessed from the HTML. That
 * matters: hr-breaker's vision filter judged a page the model never saw, and
 * nobody noticed for weeks. Whatever this returns is what was actually made.
 *
 * Needs poppler-utils on PATH: pdftotext and pdftoppm.
 */

const WRAPPER = new URL('../../templates/resume_wrapper.html', import.meta.url).pathname;

/** Wraps the generated body in the template, exactly as the Python does. */
export const wrapHtml = (wrapper: string, body: string): string =>
  wrapper.replace('{{HEADER}}', '').replace('{{BODY}}', body);

const requireTool = async (tool: string): Promise<void> => {
  try {
    await run(tool, ['-v']);
  } catch {
    throw new Error(
      `${tool} not found. Install poppler-utils. It reads the produced PDF, so the ` +
        `page count and the page image describe the real document.`,
    );
  }
};

export interface PlaywrightRendererOptions {
  /** Resolution for the page image. 150 dpi is legible for a vision model. */
  readonly imageDpi?: number;
}

export const playwrightRenderer = (opts: PlaywrightRendererOptions = {}): Renderer => {
  const dpi = opts.imageDpi ?? 150;
  let browser: Browser | null = null;
  let wrapper: string | null = null;

  const start = async (): Promise<Browser> => {
    if (browser === null) browser = await chromium.launch();
    return browser;
  };

  return {
    render: async (html: string): Promise<RenderOutput> => {
      await requireTool('pdftotext');
      await requireTool('pdftoppm');

      if (wrapper === null) wrapper = await readFile(WRAPPER, 'utf8');
      const full = wrapHtml(wrapper, html);

      const b = await start();
      const page = await b.newPage();
      let pdf: Uint8Array;
      try {
        await page.setContent(full, { waitUntil: 'load' });
        // The template carries `@page { size: letter; margin: ... }`, so let
        // the stylesheet decide. preferCSSPageSize keeps Chromium from
        // overriding it with its own default.
        pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true });
      } finally {
        await page.close();
      }

      const dir = await mkdtemp(join(tmpdir(), 'cv-optimizer-'));
      try {
        const pdfPath = join(dir, 'r.pdf');
        await writeFile(pdfPath, pdf);

        // pdftotext separates pages with a form feed.
        const { stdout } = await run('pdftotext', [pdfPath, '-']);
        const pageTexts = stdout.split('\f');
        // The last split piece is the tail after the final form feed, and is
        // empty for a well-formed document. Drop it, but never return zero
        // pages for a PDF that exists.
        if (pageTexts.length > 1 && pageTexts[pageTexts.length - 1]?.trim() === '') {
          pageTexts.pop();
        }

        await run('pdftoppm', [
          '-png',
          '-r',
          String(dpi),
          '-f',
          '1',
          '-l',
          '1',
          pdfPath,
          join(dir, 'page'),
        ]);
        const pngPage1 = new Uint8Array(await readFile(join(dir, 'page-1.png')));

        return {
          pdf,
          text: pageTexts.join('\n'),
          pngPage1,
          pageCount: pageTexts.length,
          pageTexts,
        };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },

    close: async () => {
      if (browser === null) return;
      await browser.close();
      browser = null;
    },
  };
};
