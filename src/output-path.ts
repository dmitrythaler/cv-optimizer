import { join } from 'node:path';

/**
 * Output naming, matching hr-breaker `services/pdf_storage.py`.
 *
 * Keeping the scheme identical means the two tools can write into the same
 * output folder without a reader having to know which produced what.
 */

/** `MMDD_HHMM`, as `generate_run_id()` builds it. */
export const runId = (now: Date = new Date()): string => {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(now.getMonth() + 1)}${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}`;
};

/** Port of `sanitize_filename()`: lowercase, non-alphanumerics to underscore. */
export const sanitize = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

export interface PdfNameInput {
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly company: string;
  readonly role: string | null;
  readonly langCode: string | null;
  readonly runId: string | null;
}

/**
 * `{run_id}_{first}_{last}_{company}_{role}_{lang}.pdf`
 *
 * The language code is always appended, defaulting to `en`, as the Python does.
 */
export const pdfName = (input: PdfNameInput): string => {
  const parts: string[] = [];
  if (input.runId) parts.push(input.runId);
  if (input.firstName) parts.push(sanitize(input.firstName));
  if (input.lastName) parts.push(sanitize(input.lastName));
  parts.push(sanitize(input.company));
  if (input.role) parts.push(sanitize(input.role));
  parts.push(input.langCode ? input.langCode : 'en');
  return `${parts.join('_')}.pdf`;
};

/** `{run_id}_debug_{company}_{role}/` */
export const debugDirName = (company: string, role: string | null, id: string | null): string => {
  const parts: string[] = [];
  if (id) parts.push(id);
  parts.push('debug', sanitize(company));
  if (role) parts.push(sanitize(role));
  return parts.join('_');
};

export const pdfPath = (outputDir: string, input: PdfNameInput): string =>
  join(outputDir, pdfName(input));

export const debugDirPath = (
  outputDir: string,
  company: string,
  role: string | null,
  id: string | null,
): string => join(outputDir, debugDirName(company, role, id));
