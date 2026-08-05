/**
 * Cleans a fetched job posting.
 *
 * A job board page is mostly not the job. Measured on one justjoin.it posting:
 * 609 lines fetched, of which the actual posting was lines 96-250. The rest was
 * the navigation menu, a "Check similar offers" list of other jobs, two
 * advertisement blocks and the site footer.
 *
 * That matters beyond tidiness. KeywordMatcher and VectorSimilarityMatcher
 * score the CV against this text, so every unrelated job in a "similar offers"
 * list drags the CV toward the wrong target, and the job parser can pick a
 * competitor's job title.
 *
 * Two rules, in order of value:
 *
 *  1. CUT THE TRAILER. Everything from a "similar offers" or footer marker to
 *     the end. This is where most of the junk is, and it is the safest cut -
 *     nothing after such a heading belongs to this posting.
 *  2. DROP JUNK LINES. Exact matches against a list of navigation and legal
 *     boilerplate. Exact, and only on short lines, so no real sentence can be
 *     removed by accident.
 *
 * The head of the page is deliberately KEPT. It holds the title, the company,
 * the salary and the location, which the parser needs. Cutting to the first
 * "Job description" heading would throw the company name away.
 *
 * Every cut is reported. A cleaner that quietly eats half a posting is worse
 * than no cleaner - see docs/porting-notes.md.
 */

/**
 * A line at or after one of these ends the posting. Matched on short lines
 * only, so a sentence that happens to contain the words survives.
 */
const TRAILER = [
  /^check similar offers?$/i,
  /^similar (offers?|jobs?|positions?|roles?)/i,
  /^(jobs?|offers?) like this/i,
  /^related (jobs?|offers?|positions?)/i,
  /^recommended (jobs?|for you)/i,
  /^more (jobs?|offers?) (from|at|like)/i,
  /^other (offers?|jobs?)/i,
  /^you (may|might) also like/i,
  /^people also viewed/i,
  /^advertisement/i,
  /^©\s*\d{4}/,
  /^podobne oferty/i, // pl: similar offers
  /^zobacz podobne/i, // pl: see similar
];

/**
 * Whole lines to drop. Exact match after trimming and lowercasing, because a
 * substring rule here would eat real content ("more" appears inside sentences).
 */
const JUNK_EXACT = new Set([
  'menu',
  'show menu',
  'hide menu',
  'main menu',
  'search',
  'home',
  'back',
  'next',
  'previous',
  'more',
  'new',
  'apply',
  'apply now',
  'quick apply',
  'easy apply',
  'save',
  'saved',
  'save job',
  'share',
  'share this job',
  'print',
  'report',
  'report job',
  'log in',
  'login',
  'sign in',
  'sign up',
  'register',
  'logout',
  'all offers',
  'add offer',
  'post a job',
  'job offers',
  'offers',
  'salaries',
  'salary calculator',
  'calculator',
  'companies',
  'company profiles',
  'employer panel',
  'candidate profile',
  'favorites',
  'favourites',
  'history',
  'viewed',
  'matched',
  'chats',
  'currency',
  'geek',
  'help',
  'terms',
  'terms of service',
  'privacy',
  'privacy policy',
  'cookie settings',
  'cookies',
  'accept cookies',
  'about us',
  'career',
  'careers',
  'contact',
  'contact us',
  'blog',
  'newsletter',
  'subscribe',
  'follow us',
  'skip to content',
  'skip to main content',
]);

/** Legal and tracking boilerplate. These are long lines, so match on substrings. */
const JUNK_PATTERN = [
  /consent to the processing of my personal data/i,
  /protected by recaptcha/i,
  /administratorem (pani|pana)/i, // pl: data controller notice
  /obowi[aą]zku informacyjnego/i, // pl: information duty notice
  /we use cookies/i,
  /this (website|site) uses cookies/i,
  /by (clicking|continuing|applying).{0,40}you (agree|consent)/i,
  /#\d+ job board/i,
];

/** Longest line that a structural rule may act on. Real prose is longer. */
const SHORT_LINE = 40;

export interface CleanReport {
  /** Heading that ended the posting, if the trailer rule fired. */
  readonly cutAt: string | null;
  /** Lines removed by the trailer cut. */
  readonly trailerLines: number;
  /** Lines removed one at a time as junk. */
  readonly junkLines: number;
  readonly charsBefore: number;
  readonly charsAfter: number;
  /** True when the cleaner refused its own result and kept the raw text. */
  readonly keptRaw: boolean;
}

/** Below this a posting is not a posting, and the cleaner has overreached. */
const MIN_USEFUL = 400;

export const cleanJobText = (raw: string): { text: string; report: CleanReport } => {
  // Zero-width characters arrive as their own lines and confuse line counting.
  const lines = raw.replace(/[​-‍﻿]/g, '').split('\n');

  // 1. Trailer cut. Only in the last two thirds, so a navigation entry near the
  // top ("All offers") cannot truncate the whole page.
  const floor = Math.floor(lines.length / 3);
  let cutIndex = lines.length;
  let cutAt: string | null = null;
  for (let i = floor; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (line === '' || line.length > SHORT_LINE) continue;
    if (TRAILER.some((re) => re.test(line))) {
      cutIndex = i;
      cutAt = line;
      break;
    }
  }
  const trailerLines = lines.length - cutIndex;
  const kept = lines.slice(0, cutIndex);

  // 2. Junk lines.
  let junkLines = 0;
  const out: string[] = [];
  for (const rawLine of kept) {
    const line = rawLine.trim();
    const isJunk =
      (line.length <= SHORT_LINE && JUNK_EXACT.has(line.toLowerCase())) ||
      JUNK_PATTERN.some((re) => re.test(line));
    if (isJunk) {
      junkLines++;
      continue;
    }
    // A nav bar repeats itself; so does a sticky header.
    if (line !== '' && line === out[out.length - 1]) {
      junkLines++;
      continue;
    }
    out.push(line);
  }

  const text = out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const report = {
    cutAt,
    trailerLines,
    junkLines,
    charsBefore: raw.length,
    charsAfter: text.length,
    keptRaw: false,
  };

  // The cleaner does not get to destroy the input. If what is left is too small
  // to be a job posting, the rules were wrong about this page - hand back the
  // raw text and say so, rather than passing an empty JD down the pipeline.
  if (text.length < MIN_USEFUL && raw.trim().length >= MIN_USEFUL) {
    return {
      text: raw.trim(),
      report: { ...report, keptRaw: true, charsAfter: raw.trim().length },
    };
  }

  return { text, report };
};

/** One line for the log. */
export const describeClean = (r: CleanReport): string => {
  if (r.keptRaw) {
    return `job text cleaning REFUSED: it would have left ${r.charsBefore} chars as too little - raw text kept`;
  }
  const pct = r.charsBefore === 0 ? 0 : Math.round((1 - r.charsAfter / r.charsBefore) * 100);
  const cut = r.cutAt === null ? 'no trailer found' : `cut at ${JSON.stringify(r.cutAt)}`;
  return (
    `job text cleaned: ${r.charsBefore} -> ${r.charsAfter} chars (-${pct}%), ` +
    `${cut}, ${r.trailerLines} trailer lines, ${r.junkLines} junk lines`
  );
};
