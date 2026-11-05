/**
 * Tells a BROKEN PROVIDER apart from a BAD CV.
 *
 * `registry.ts` turns a filter exception into a FAILED result, on the rule that
 * a bug must not read as approval. That rule is right for a bug in the filter.
 * It is wrong for an error that says nothing about the CV at all.
 *
 * MEASURED, 2026-11-05. The Gemini prepay balance hit zero. LayoutChecker threw
 * on every call, each throw became `score 0.0, passed: false`, and so:
 *
 *  - no iteration could ever pass, so `if (passed) break` never fired;
 *  - all 3 iterations ran for all 12 jobs in the batch, and every one of those
 *    extra rounds paid for a generate step that could not be graded;
 *  - the last iteration was filed, as designed. For Braver IT (Media) that
 *    threw away iteration 2, which passed the other 7 filters at ATS 0.756,
 *    and filed iteration 3 at ATS 0.606 instead;
 *  - the run reported "FAILED filters: AtsChecker, LayoutChecker", so the
 *    output read as a judgement about the CV. It was a judgement about a wallet.
 *
 * So: an error from the provider ends the run. It does not grade the CV, and it
 * does not buy another iteration. See docs/design-notes.md.
 */

/** The provider cannot answer. The run must stop; the CV was never graded. */
export class ProviderUnavailableError extends Error {
  readonly filterName: string;
  readonly fault: string;

  constructor(filterName: string, fault: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message.trim() : String(cause);
    super(`${filterName} could not run: ${fault}. The CV was NOT graded.\n  ${detail}`);
    this.name = 'ProviderUnavailableError';
    this.filterName = filterName;
    this.fault = fault;
    this.cause = cause;
  }
}

/** HTTP status, as the AI SDK and most clients report it. */
const statusOf = (err: unknown): number | null => {
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur !== null && cur !== undefined; depth++) {
    const o = cur as { statusCode?: unknown; status?: unknown; cause?: unknown };
    for (const v of [o.statusCode, o.status]) {
      if (typeof v === 'number' && v >= 400) return v;
    }
    cur = o.cause;
  }
  return null;
};

/** The message, the name, and the response body of the whole cause chain. */
const textOf = (err: unknown): string => {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur !== null && cur !== undefined; depth++) {
    if (cur instanceof Error) {
      parts.push(cur.name, cur.message);
      const body = (cur as { responseBody?: unknown }).responseBody;
      if (typeof body === 'string') parts.push(body);
      cur = cur.cause;
    } else {
      parts.push(String(cur));
      break;
    }
  }
  return parts.join(' ');
};

/**
 * Wording that names the provider, never the document.
 *
 * Deliberately a short list. A pattern that is too wide hides a real filter bug
 * behind "the provider is down", which is the same mistake in the other
 * direction. Add a line only for wording a provider actually sent.
 *
 * Every pattern must be wording that a CV cannot contain. A Zod error echoes
 * the model's own output back, so the CV text reaches this function: a plain
 * /billing/ or /rate limit/ would abort the run over a bullet about a billing
 * system. Transport conditions are matched by HTTP status instead, which no
 * document can imitate.
 */
const FAULTS: readonly (readonly [RegExp, string])[] = [
  [/prepayment credits are depleted/i, 'the provider prepay balance is empty'],
  [/insufficient (?:balance|credit|credits|funds|quota)/i, 'the provider account has no credit'],
  [/\b(?:no|not enough) balance\b/i, 'the provider account has no credit'],
  [
    /(?:exceeded your current quota|quota (?:exceeded|exhausted))/i,
    'the provider quota is used up',
  ],
  [/\bRESOURCE_EXHAUSTED\b/, 'the provider refused the call: quota or rate limit'],
  [
    /(?:api key not valid|invalid api key|incorrect api key|api key expired)/i,
    'the provider rejected the API key',
  ],
  [/\b(?:UNAUTHENTICATED|PERMISSION_DENIED)\b/, 'the provider rejected the credentials'],
  [/\bAuthentication Fails\b/i, 'the provider rejected the credentials'],
];

/**
 * Names the provider fault, or `null` when the error is the filter's own.
 *
 * A rate limit is transient, so ending a 20-minute run over one looks harsh.
 * It is still the cheap choice. The AI SDK already retried before it threw, and
 * the alternative is to pay for another generate step and grade nothing. Re-run
 * the job; nothing is lost but the clock.
 */
export const providerFault = (err: unknown): string | null => {
  const status = statusOf(err);
  if (status === 401 || status === 403)
    return 'the provider rejected the credentials (HTTP 401/403)';
  if (status === 402) return 'the provider wants payment (HTTP 402)';
  if (status === 429) return 'the provider refused the call (HTTP 429: quota or rate limit)';

  const text = textOf(err);
  for (const [pattern, fault] of FAULTS) {
    if (pattern.test(text)) return fault;
  }
  return null;
};
