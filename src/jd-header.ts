/**
 * Reads the header block the crawler writes at the top of every `jd.txt`.
 *
 *   Senior Full-Stack Product Engineer     <- title
 *   The Flex                               <- company
 *   Remote worldwide except US/Canada      <- location
 *   Salary: Not disclosed
 *   Posted: 2026-09-23
 *   Source: https://...
 *
 *   ======================================================================
 *
 *   ...the posting...
 *
 * WHY THIS EXISTS. The title and the company were read out of the posting by a
 * model, and a model reads what the text repeats. The Flex posting names its
 * product `Base360.ai` eleven times and the employer three, so the CV came out
 * as `Dmitry.Thaler.CV.base360_ai.pdf` - a file named after a company that is
 * not the employer, which is exactly how the wrong PDF gets attached. Both
 * Magpie postings came out with an empty position and collided on one name.
 *
 * The header is not a guess. The crawler wrote it from the board's own fields,
 * so when it is there it WINS over anything read out of the prose.
 */

export interface JdHeader {
  readonly title: string;
  readonly company: string;
  readonly location: string | null;
}

/** The separator the crawler writes: a line of at least 20 `=`. */
const RULE = /^={20,}$/;

/**
 * Returns the header, or null when this file does not have one.
 *
 * Strict on purpose. A hand-written jd.txt, or a posting pasted raw, must fall
 * through to the parsed values rather than have its first two lines taken as a
 * title and a company.
 */
export function parseJdHeader(text: string): JdHeader | null {
  const lines = text.split('\n');
  // The rule has to be near the top, or this is prose that happens to contain
  // a row of equals signs.
  const rule = lines.findIndex((l) => RULE.test(l.trim()));
  if (rule === -1 || rule > 12) return null;

  const head = lines.slice(0, rule).map((l) => l.trim());
  // Every field the crawler writes must be there. Three of the six are labelled,
  // and the labels are what make this a header rather than three lines of text.
  const labelled = (name: string): string | null => {
    const hit = head.find((l) => new RegExp(`^${name}:`, 'i').test(l));
    return hit ? hit.slice(hit.indexOf(':') + 1).trim() : null;
  };
  if (labelled('Salary') === null || labelled('Posted') === null || labelled('Source') === null) return null;

  const [title, company, location] = head;
  if (!title || !company) return null;
  // A labelled line in either slot means the block is not shaped as expected.
  if (/^(salary|posted|source|location):/i.test(title) || /^(salary|posted|source|location):/i.test(company)) {
    return null;
  }
  return { title, company, location: location && !/^(salary|posted|source):/i.test(location) ? location : null };
}
