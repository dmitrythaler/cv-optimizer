import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { RenderOutput, Renderer } from './pdf.ts';

const run = promisify(execFile);

/**
 * Renders resume MARKDOWN to PDF with pandoc and WeasyPrint.
 *
 * This replaced the Chromium renderer on 2026-09-03. The source CV is pandoc
 * markdown, so the generator now edits the SAME format it reads, instead of
 * rewriting it into HTML. A verbatim block stays verbatim because it is copied,
 * not regenerated.
 *
 *   pandoc cv.md --standalone --pdf-engine=weasyprint --css=cv.css -o out.pdf
 *
 * PANDOC RUNS WITH ITS WORKING DIRECTORY SET TO templates/. That is not a
 * detail: `--css=cv.css` becomes a relative <link> in the intermediate HTML,
 * and cv.css then loads fonts/Carlito-*.woff2 by a relative url() of its own.
 * Run it from anywhere else and both quietly resolve to nothing - WeasyPrint
 * does not fail, it just renders in a default serif face. Verify with
 * `pdffonts`, never by eye.
 *
 * The page count, the per-page text and the page image all come from the
 * PRODUCED PDF, through poppler. They are never guessed from the markdown.
 * That matters: a vision filter that judges a page the model never saw fails
 * silently.
 *
 * Needs pandoc, weasyprint, pdftotext and pdftoppm on PATH.
 */

const TEMPLATES = new URL('../../templates', import.meta.url).pathname;

const requireTool = async (tool: string, args: string[], hint: string): Promise<void> => {
  try {
    await run(tool, args);
  } catch {
    throw new Error(`${tool} not found. ${hint}`);
  }
};

export interface PandocRendererOptions {
  /** Resolution for the page image. 150 dpi is legible for a vision model. */
  readonly imageDpi?: number;
  /** Stylesheet name, resolved inside templates/. */
  readonly css?: string;
}

export const pandocRenderer = (opts: PandocRendererOptions = {}): Renderer => {
  const dpi = opts.imageDpi ?? 150;
  const css = opts.css ?? 'cv.css';
  let checked = false;

  return {
    render: async (markdown: string): Promise<RenderOutput> => {
      if (!checked) {
        await requireTool('pandoc', ['--version'], 'Install pandoc.');
        await requireTool('weasyprint', ['--version'], 'Install WeasyPrint.');
        await requireTool('pdftotext', ['-v'], 'Install poppler-utils.');
        await requireTool('pdftoppm', ['-v'], 'Install poppler-utils.');
        checked = true;
      }

      const dir = await mkdtemp(join(tmpdir(), 'cv-optimizer-'));
      try {
        const mdPath = join(dir, 'resume.md');
        const pdfPath = join(dir, 'r.pdf');
        await writeFile(mdPath, markdown, 'utf8');

        await run(
          'pandoc',
          [
            mdPath,
            '--standalone',
            '--pdf-engine=weasyprint',
            `--css=${css}`,
            // Silences pandoc's "no title" warning on stderr. The stylesheet
            // draws the name from the .cv-name span, not from metadata.
            '--metadata',
            'title=',
            '--output',
            pdfPath,
          ],
          { cwd: TEMPLATES },
        );

        const pdf = new Uint8Array(await readFile(pdfPath));

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

    // pandoc is a process per render, so there is nothing to keep alive and
    // nothing to close. The method stays to satisfy the Renderer contract.
    close: () => Promise.resolve(),
  };
};
