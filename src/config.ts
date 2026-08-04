import process from 'node:process';

/**
 * Settings, resolved from env vars with defaults.
 *
 * Thresholds are deliberately explicit rather than clever: the Python original
 * shipped a filter whose threshold was mathematically unreachable for two
 * months without anyone noticing. See docs/porting-notes.md.
 */

const num = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`env ${key} must be a number, got ${JSON.stringify(raw)}`);
  }
  return parsed;
};

const str = (key: string, fallback: string): string => process.env[key] || fallback;

const bool = (key: string, fallback: boolean): boolean => {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
};

export interface Config {
  readonly chatModel: string;
  readonly embedding: {
    /** Hugging Face repo id of an ONNX-exported model, run locally. No API, no key. */
    readonly model: string;
    /** Truncate embedding output to this many dimensions. 0 = model default. */
    readonly dimensions: number;
    /** Inputs longer than the model's window are silently truncated - guard against it. */
    readonly maxInputTokens: number;
  };
  readonly maxIterations: number;
  /**
   * hr-breaker's `--no-shame`: swaps strict grading for lenient prompts and
   * bounds. Massively relaxes the fabrication checks - use with caution.
   */
  readonly noShame: boolean;
  readonly keyword: {
    /** sklearn `max_features` for the job-text vectorizer. */
    readonly maxFeatures: number;
    /** TF-IDF weight above which a term counts as significant. Strict >. */
    readonly cutoff: number;
    /** How many missing keywords to name in the failure message. */
    readonly maxMissingDisplay: number;
  };
  readonly resume: {
    /**
     * A 2-page CV whose second page holds less than this many characters is
     * treated as page-1 overflow rather than a genuine second page.
     */
    readonly page2OverflowChars: number;
  };
  readonly thresholds: {
    readonly keyword: number;
    readonly vector: number;
    readonly hallucination: number;
    readonly aiGenerated: number;
    /** Minimum weighted ATS score. Named `filter_llm_threshold` in hr-breaker. */
    readonly vision: number;
  };
  readonly logLevel: string;
}

export const loadConfig = (): Config => ({
  chatModel: str('CHAT_MODEL', 'deepseek/deepseek-chat'),

  embedding: {
    // bge-m3: multilingual (some job descriptions are in Polish) and an 8192
    // token window, which a 2-page CV needs. Repo id verified 2026-08-04 to
    // exist with ONNX weights. NOTE: nothing loads this yet - the worker's
    // model load is still a TODO and VectorSimilarity is not implemented.
    model: str('EMBEDDING_MODEL', 'Xenova/bge-m3'),
    dimensions: num('EMBEDDING_DIMENSIONS', 0),
    maxInputTokens: num('EMBEDDING_MAX_INPUT_TOKENS', 8192),
  },

  maxIterations: num('MAX_ITERATIONS', 3),
  noShame: bool('NO_SHAME', false),

  keyword: {
    maxFeatures: num('KEYWORD_TFIDF_MAX_FEATURES', 200),
    cutoff: num('KEYWORD_TFIDF_CUTOFF', 0.1),
    maxMissingDisplay: num('KEYWORD_MAX_MISSING_DISPLAY', 10),
  },

  resume: {
    // 5000 is the value hr-breaker actually runs with (set in its .env). Note
    // the Python *code* default is 1000 - the env override is the effective
    // one, so that is what is carried over for behavioural parity.
    page2OverflowChars: num('RESUME_PAGE2_OVERFLOW_CHARS', 5000),
  },

  thresholds: {
    keyword: num('THRESHOLD_KEYWORD', 0.25),

    // NOT CALIBRATED. The 0.55 inherited from the Python version was measured
    // against hosted gemini-embedding-001 at 768 dims; a different model has a
    // different cosine distribution, so that number does not transfer.
    // NaN makes every comparison false, so the filter fails loudly until this
    // is measured. Do not replace it with a guess - see docs/porting-notes.md.
    vector: num('THRESHOLD_VECTOR', Number.NaN),

    hallucination: num('THRESHOLD_HALLUCINATION', 0.9),
    aiGenerated: num('THRESHOLD_AI_GENERATED', 0.4),
    vision: num('THRESHOLD_VISION', 0.7),
  },

  logLevel: str('LOG_LEVEL', 'info'),
});
