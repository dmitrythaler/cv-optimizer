import { logger } from './logger.ts';
import { cleanJobText, describeClean } from './job-text.ts';
import { extractJobPostingLd } from './job-ld.ts';
import type { CleanReport } from './job-text.ts';

/**
 * Fetches a job posting from a URL.
 *
 * hr-breaker chains httpx, then the Wayback Machine, then Playwright. This
 * port keeps the first and the last and drops Wayback: a job board snapshot is
 * rarely in the archive, and a stale snapshot of a live posting is worse than
 * no snapshot.
 *
 * Plain fetch first, because it is fast and costs nothing. The browser second,
 * because most job boards render with JavaScript or sit behind Cloudflare.
 * hr-breaker's notes record that its own Playwright fallback never worked -
 * the browser was never installed in that venv - so in practice it only ever
 * had plain fetch. Here the browser is installed and used.
 */

const looksBlocked = (html: string): boolean =>
  /just a moment|checking your browser|cf-browser-verification|enable javascript/i.test(html);

/** Strips markup and returns readable text. Enough for a model to parse. */
export const htmlToText = (html: string): string =>
  html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim();

const MIN_LENGTH = 200;

/**
 * What a fetch returns: the raw HTML, and readable text taken from it.
 *
 * The HTML is kept because the JSON-LD extractor needs the `<script>` blocks,
 * and both the markup stripper and the browser path throw scripts away.
 */
interface Page {
  readonly html: string;
  readonly text: string;
}

const viaFetch = async (url: string): Promise<Page> => {
  const res = await fetch(url, {
    headers: {
      // Job boards commonly refuse a bare client.
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  if (looksBlocked(html)) throw new Error('blocked by a bot check');
  const text = htmlToText(html);
  if (text.length < MIN_LENGTH) throw new Error(`only ${text.length} chars of text`);
  return { html, text };
};

/**
 * Structural elements that never hold the job. Removed in the DOM, where the
 * decision is reliable, before any text is extracted. The text-level cleaner in
 * `job-text.ts` then handles what survives.
 */
const CHROME_SELECTORS = [
  'nav',
  'footer',
  'aside',
  'script',
  'style',
  'noscript',
  'iframe',
  'svg',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[aria-label*="cookie" i]',
];

const viaBrowser = async (url: string): Promise<Page> => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Job boards render late. Wait for the network to settle, but do not fail
    // the whole fetch if it never does.
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);

    // Capture the markup BEFORE pruning. The JSON-LD lives in a <script>, and
    // the prune below removes every script on the page.
    const html = await page.content();

    // innerText beats parsing the markup: it follows what is actually rendered
    // and leaves out anything hidden.
    //
    // The callback runs in the browser, so `document` is not a Node global. It
    // is reached through globalThis with a minimal local type - adding the whole
    // "dom" lib to tsconfig would put browser globals in scope for every server
    // file, which is how `document` typos reach production.
    const text = await page.evaluate((selectors: string[]) => {
      const doc = (
        globalThis as unknown as {
          document?: {
            querySelectorAll(s: string): Iterable<{ remove(): void }>;
            body: { innerText: string };
          };
        }
      ).document;
      if (doc === undefined) return '';
      for (const sel of selectors) {
        for (const el of Array.from(doc.querySelectorAll(sel))) el.remove();
      }
      return doc.body.innerText;
    }, CHROME_SELECTORS);

    if (text.length < MIN_LENGTH) throw new Error(`only ${text.length} chars of text`);
    return { html, text };
  } finally {
    await browser.close();
  }
};

export interface FetchedJob {
  /** The posting text. This is what the parser and the filters see. */
  readonly text: string;
  readonly url: string;
  readonly method: 'request' | 'browser';
  /**
   * How the posting was separated from the page.
   *  - `json-ld`      schema.org JobPosting. Exact, and language-independent.
   *  - `cleaned-html` the word-list heuristic. Only as good as its word lists.
   */
  readonly strategy: 'json-ld' | 'cleaned-html';
  /** Only set for `cleaned-html`. Nothing is stripped on the json-ld path. */
  readonly clean: CleanReport | null;
}

/**
 * Fetches a posting and separates it from the page around it.
 *
 * Plain request first, then a real browser.
 *
 * Then, in order:
 *  1. schema.org JobPosting from the page's JSON-LD. This is the posting
 *     itself, so there is nothing to strip and nothing to strip by mistake,
 *     and it works whatever language the posting is written in.
 *  2. The word-list heuristic in `job-text.ts`. It only ever works for
 *     languages someone thought to add - a German page keeps nearly all of its
 *     junk - so it is the fallback, not the plan.
 */
export const fetchJob = async (url: string): Promise<FetchedJob> => {
  const errors: string[] = [];
  let page: Page | null = null;
  let method: 'request' | 'browser' = 'request';

  try {
    page = await viaFetch(url);
    logger.info(`fetched ${url} with a plain request (${page.text.length} chars)`);
  } catch (err: unknown) {
    errors.push(`fetch: ${err instanceof Error ? err.message : String(err)}`);
    logger.warn(`plain request failed for ${url}, trying a browser`);
    try {
      page = await viaBrowser(url);
      method = 'browser';
      logger.info(`fetched ${url} with a browser (${page.text.length} chars)`);
    } catch (err2: unknown) {
      errors.push(`browser: ${err2 instanceof Error ? err2.message : String(err2)}`);
    }
  }
  if (page === null) throw new Error(`could not fetch ${url}. Tried ${errors.join('; ')}`);

  const ld = extractJobPostingLd(page.html);
  if (ld !== null) {
    logger.info(
      `job read from schema.org JSON-LD: ${ld.descriptionChars} chars of description` +
        `${ld.company === null ? '' : ` at ${ld.company}`} - no cleaning needed`,
    );
    return { text: ld.text, url, method, strategy: 'json-ld', clean: null };
  }

  logger.info('no schema.org JobPosting on the page, falling back to the word-list cleaner');
  const { text, report: clean } = cleanJobText(page.text);
  const line = describeClean(clean);
  if (clean.keptRaw) logger.warn(line);
  else logger.info(line);

  return { text, url, method, strategy: 'cleaned-html', clean };
};
