import { join } from 'node:path';

/**
 * Output naming.
 *
 * One run produces one FOLDER, named after the run and the job:
 *
 *   output/20260805-0912-link_group-full_stack_engineer/
 *     John.Dow.CV.link_group.full_stack_engineer.pdf   <- CV_NAME_TEMPLATE
 *     iteration_1.pdf
 *     iteration_1.png
 *     iteration_2.pdf
 *     iteration_2.png
 *     optimization.json
 *     errors.log                                            <- only if errors
 *
 * The folder name carries no personal name, and matches the convention the
 * job-scanning side uses for `../applications/*`. The CV file name inside is
 * fully under the operator's control through CV_NAME_TEMPLATE, because that is
 * the name a recruiter sees once the file leaves the folder.
 */

/** Lowercase, and every run of non-alphanumerics becomes one underscore. */
export const sanitize = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

export interface Stamp {
  /** `YYYYMMDD` */
  readonly date: string;
  /** `HHMM` */
  readonly time: string;
}

export const stamp = (now: Date = new Date()): Stamp => {
  const p = (n: number): string => String(n).padStart(2, '0');
  return {
    date: `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`,
    time: `${p(now.getHours())}${p(now.getMinutes())}`,
  };
};

export interface RunNaming {
  readonly date: string;
  readonly time: string;
  readonly company: string;
  readonly position: string | null;
  readonly lang: string;
}

export const naming = (
  company: string,
  position: string | null,
  lang: string | null,
  at: Stamp = stamp(),
): RunNaming => ({
  date: at.date,
  time: at.time,
  company: sanitize(company) || 'unknown',
  position: position === null ? null : sanitize(position) || null,
  lang: lang ?? 'en',
});

/** `{date}-{time}-{company_slug}-{position_slug}` */
export const runFolderName = (n: RunNaming): string => {
  const parts = [n.date, n.time, n.company];
  if (n.position) parts.push(n.position);
  return parts.join('-');
};

export const runFolderPath = (outputDir: string, n: RunNaming): string =>
  join(outputDir, runFolderName(n));

/**
 * Placeholders CV_NAME_TEMPLATE accepts. `*_slug` are aliases, because a
 * company or a position in a file name is always a slug - there is no unslugged
 * form to choose instead.
 */
const VARS = ['date', 'time', 'company', 'company_slug', 'position', 'position_slug', 'lang'];

/**
 * Fills CV_NAME_TEMPLATE.
 *
 * An unknown placeholder THROWS. A silently-unreplaced `{compnay}` would ship a
 * file literally called `CV.{compnay}.pdf`, and nobody would notice until a
 * recruiter did.
 */
export const renderCvName = (template: string, n: RunNaming): string => {
  const value: Record<string, string> = {
    date: n.date,
    time: n.time,
    company: n.company,
    company_slug: n.company,
    position: n.position ?? '',
    position_slug: n.position ?? '',
    lang: n.lang,
  };

  const unknown = [...template.matchAll(/\{([^}]*)\}/g)]
    .map((m) => m[1] ?? '')
    .filter((k) => !VARS.includes(k));
  if (unknown.length > 0) {
    throw new Error(
      `CV_NAME_TEMPLATE has unknown placeholder(s): ${unknown.map((u) => `{${u}}`).join(', ')}. ` +
        `Known: ${VARS.map((v) => `{${v}}`).join(', ')}`,
    );
  }

  let name = template.replace(/\{([^}]*)\}/g, (_, k: string) => value[k] ?? '');

  // A template with an empty {position} leaves a doubled separator behind.
  name = name.replace(/([.\-_ ])\1+/g, '$1').replace(/[.\-_ ]+(\.pdf)$/i, '$1');

  // Never let a template escape its folder.
  name = name.replace(/[/\\\0]/g, '_').trim();

  if (name === '' || name.toLowerCase() === '.pdf') {
    throw new Error(`CV_NAME_TEMPLATE ${JSON.stringify(template)} produced an empty file name`);
  }
  if (!name.toLowerCase().endsWith('.pdf')) name += '.pdf';
  return name;
};

/** The job description the run actually worked from, after cleaning. */
export const JD_TXT = 'jd.txt';
export const ITERATION_PDF = (n: number): string => `iteration_${n}.pdf`;
export const ITERATION_PNG = (n: number): string => `iteration_${n}.png`;
export const OPTIMIZATION_JSON = 'optimization.json';
export const ERRORS_LOG = 'errors.log';
