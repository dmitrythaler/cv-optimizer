import { htmlToText } from './fetch-job.ts';

/**
 * Reads a schema.org JobPosting out of a page's JSON-LD.
 *
 * This is the right way to get a posting, and the heuristic cleaner in
 * `job-text.ts` is the fallback for pages that do not offer one.
 *
 * Why it wins:
 *  - It is the posting, not the page. No navigation, no "similar offers", no
 *    footer, so there is nothing to strip and nothing to strip by mistake.
 *  - It is LANGUAGE-INDEPENDENT. The heuristic rules are word lists, so they
 *    only ever work for the languages someone thought to add. A German page
 *    keeps almost all of its junk. `"@type": "JobPosting"` is the same token in
 *    every language.
 *  - Nearly every serious board publishes it, because Google requires it for
 *    Google Jobs indexing. Confirmed 2026-08-05 on xing.com and justjoin.it.
 *
 * Measured on the xing.com posting that prompted this: 292 KB of HTML, of which
 * the JobPosting description is 2608 characters.
 */

export interface LdJob {
  readonly text: string;
  readonly title: string | null;
  readonly company: string | null;
  /** Characters of description, before the header lines are added. */
  readonly descriptionChars: number;
}

/** Anything shorter than this is a stub, and the full page is a better source. */
const MIN_DESCRIPTION = 300;

type Json = Record<string, unknown>;

const asString = (v: unknown): string | null => {
  if (typeof v === 'string' && v.trim() !== '') return v.trim();
  return null;
};

/** `@type` may be a string or an array of them. */
const isJobPosting = (node: unknown): node is Json => {
  if (typeof node !== 'object' || node === null) return false;
  const t = (node as Json)['@type'];
  if (typeof t === 'string') return t === 'JobPosting';
  if (Array.isArray(t)) return t.includes('JobPosting');
  return false;
};

/** JSON-LD nests under `@graph`, arrays, or neither. Walk all of it. */
const findJobPosting = (node: unknown, depth = 0): Json | null => {
  if (depth > 6 || node === null || typeof node !== 'object') return null;
  if (isJobPosting(node)) return node;
  const values = Array.isArray(node) ? node : Object.values(node as Json);
  for (const v of values) {
    const found = findJobPosting(v, depth + 1);
    if (found !== null) return found;
  }
  return null;
};

/** `{name: "..."}`, or a bare string. */
const nameOf = (v: unknown): string | null => {
  if (typeof v === 'string') return asString(v);
  if (typeof v === 'object' && v !== null) return asString((v as Json)['name']);
  return null;
};

const locationOf = (v: unknown): string | null => {
  const first = Array.isArray(v) ? v[0] : v;
  if (typeof first !== 'object' || first === null) return asString(first);
  const addr = (first as Json)['address'];
  if (typeof addr !== 'object' || addr === null) return nameOf(first);
  const a = addr as Json;
  const parts = [a['addressLocality'], a['addressRegion'], a['addressCountry']]
    .map((p) => nameOf(p))
    .filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(', ') : null;
};

/**
 * A board's own template bug: xing.com ends its description with ten lines of
 * the literal word "null". No posting ever says that on a line of its own.
 */
const dropStrayNulls = (text: string): string =>
  text
    .split('\n')
    .filter((l) => !/^(null|undefined)$/i.test(l.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** `TELECOMMUTE` is the schema.org token. Say it the way a reader would. */
const REMOTE_WORDS: Record<string, string> = { TELECOMMUTE: 'Remote' };

const salaryOf = (v: unknown): string | null => {
  if (typeof v !== 'object' || v === null) return null;
  const s = v as Json;
  const currency = asString(s['currency']) ?? '';
  const value = s['value'];
  if (typeof value !== 'object' || value === null) return null;
  const val = value as Json;
  const min = val['minValue'];
  const max = val['maxValue'];
  const unit = asString(val['unitText']) ?? '';
  const single = val['value'];
  const amount =
    min !== undefined && max !== undefined
      ? `${String(min)} - ${String(max)}`
      : single !== undefined
        ? String(single)
        : null;
  if (amount === null) return null;
  return `${amount} ${currency} ${unit}`.replace(/\s+/g, ' ').trim();
};

/**
 * Pulls the JobPosting out of raw page HTML.
 *
 * Returns null when the page has none, or when what it has is too short to be
 * a real posting - some boards emit a stub for the search-result card.
 */
export const extractJobPostingLd = (html: string): LdJob | null => {
  const blocks = [
    ...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi),
  ];

  for (const block of blocks) {
    const body = block[1];
    if (body === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      // A broken JSON-LD block is common and is not an error worth stopping
      // for. The next block, or the heuristic cleaner, still applies.
      continue;
    }

    const job = findJobPosting(parsed);
    if (job === null) continue;

    // `description` is HTML in practice, whatever the spec says.
    const description = dropStrayNulls(htmlToText(asString(job['description']) ?? ''));
    if (description.length < MIN_DESCRIPTION) continue;

    const title = asString(job['title']);
    const company = nameOf(job['hiringOrganization']);

    // A header, because the parser reads title, company and salary from the
    // text and the description alone rarely repeats them.
    const header: string[] = [];
    if (title !== null) header.push(title);
    if (company !== null) header.push(company);
    const where = locationOf(job['jobLocation']);
    if (where !== null) header.push(where);
    const remote = nameOf(job['jobLocationType']);
    if (remote !== null) header.push(REMOTE_WORDS[remote.toUpperCase()] ?? remote);
    const employment = Array.isArray(job['employmentType'])
      ? job['employmentType'].map((e) => nameOf(e)).filter((e): e is string => e !== null)
      : [nameOf(job['employmentType'])].filter((e): e is string => e !== null);
    if (employment.length > 0) header.push(employment.join(', '));
    const salary = salaryOf(job['baseSalary']);
    if (salary !== null) header.push(`Salary: ${salary}`);

    return {
      text: `${header.join('\n')}\n\n${description}`.trim(),
      title,
      company,
      descriptionChars: description.length,
    };
  }

  return null;
};
