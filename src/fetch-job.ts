import { writeFile } from 'node:fs/promises';
import { logger } from './logger.ts';

/**
 * Fetches a job posting from a URL and saves the text to a file.
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

const viaFetch = async (url: string): Promise<string> => {
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
  return text;
};

const viaBrowser = async (url: string): Promise<string> => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Job boards render late. Wait for the network to settle, but do not fail
    // the whole fetch if it never does.
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
    const text = htmlToText(await page.content());
    if (text.length < MIN_LENGTH) throw new Error(`only ${text.length} chars of text`);
    return text;
  } finally {
    await browser.close();
  }
};

/** Fetches the posting text. Tries a plain request, then a real browser. */
export const fetchJobText = async (url: string): Promise<string> => {
  const errors: string[] = [];
  try {
    const text = await viaFetch(url);
    logger.info(`fetched ${url} with a plain request (${text.length} chars)`);
    return text;
  } catch (err: unknown) {
    errors.push(`fetch: ${err instanceof Error ? err.message : String(err)}`);
    logger.warn(`plain request failed for ${url}, trying a browser`);
  }
  try {
    const text = await viaBrowser(url);
    logger.info(`fetched ${url} with a browser (${text.length} chars)`);
    return text;
  } catch (err: unknown) {
    errors.push(`browser: ${err instanceof Error ? err.message : String(err)}`);
  }
  throw new Error(`could not fetch ${url}. Tried ${errors.join('; ')}`);
};

/** Fetches a posting and writes it to `out`. Returns the text. */
export const fetchJobToFile = async (url: string, out: string): Promise<string> => {
  const text = await fetchJobText(url);
  await writeFile(out, text, 'utf8');
  logger.info(`saved to ${out}`);
  return text;
};
