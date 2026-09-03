import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pandocRenderer } from '../src/render/pandoc.ts';

/**
 * Exercises the real renderer: pandoc and WeasyPrint make a PDF, poppler reads
 * it back.
 *
 * Skipped when a tool is missing, so a bare checkout does not fail.
 */
const has = (tool: string, flag = '-v'): boolean => {
	try {
		execFileSync(tool, [flag], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
};
const ready =
	has('pandoc', '--version') &&
	has('weasyprint', '--version') &&
	has('pdftotext') &&
	has('pdftoppm');
const opts = ready ? {} : { skip: 'needs pandoc, weasyprint and poppler-utils' };

const renderer = pandocRenderer();

const CV = [
	'[Jane Doe]{.cv-name}',
	'',
	'::: {.contacts}',
	'jane@doe.dev',
	':::',
	'',
	'::: {.summary}',
	'A backend engineer.',
	':::',
	'',
	'## Selected Professional Experience',
	'',
	'::: {.entry}',
	'### **Acme** - *Engineer*',
	'',
	'**Jan 2020 - Jan 2024**',
	'',
	'* Built things.',
	':::',
].join('\n');

test('renderer: markdown becomes a real PDF, read back through poppler', opts, async () => {
	const out = await renderer.render(CV);

	// A PDF, not an HTML blob that happens to be non-empty.
	assert.equal(new TextDecoder().decode(out.pdf.slice(0, 5)), '%PDF-');
	assert.equal(out.pageCount, 1);
	assert.equal(out.pageTexts.length, 1);

	// The text comes out of the PRODUCED PDF, so this also proves the fences
	// were consumed as markup rather than printed as literal text.
	assert.match(out.text, /JANE DOE/);
	assert.match(out.text, /Built things/);
	assert.doesNotMatch(out.text, /:::/);
	assert.doesNotMatch(out.text, /\*\*/);

	// The vision filter grades this image. An empty one fails silently.
	assert.ok(out.pngPage1.length > 1000, 'page image is not empty');
});

test('renderer: the Carlito faces from cv.css are embedded', opts, async () => {
	// If pandoc runs outside templates/, the relative --css and the relative
	// font url() both resolve to nothing and WeasyPrint quietly falls back to a
	// default face. The PDF still renders, so only the font table catches it.
	const { writeFile, mkdtemp, rm } = await import('node:fs/promises');
	const { tmpdir } = await import('node:os');
	const { join } = await import('node:path');
	const out = await renderer.render(CV);
	const dir = await mkdtemp(join(tmpdir(), 'renderer-test-'));
	try {
		const pdf = join(dir, 'r.pdf');
		await writeFile(pdf, out.pdf);
		const fonts = execFileSync('pdffonts', [pdf], { encoding: 'utf8' });
		assert.match(fonts, /Carlito/, `cv.css did not load its fonts:\n${fonts}`);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

after(async () => {
	await renderer.close();
});
