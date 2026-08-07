import process from 'node:process';

/** .env is loaded by Node's --env-file flag. Nothing to do here. */
const loadEnvFile = (): void => {};

/**
 * Settings, resolved from env vars with defaults.
 *
 * Thresholds are deliberately explicit rather than clever. A threshold that is
 * mathematically unreachable makes a filter pass everything, and nothing about
 * a running system says so. See docs/design-notes.md.
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

/**
 * THRESHOLD_VISION was renamed to THRESHOLD_ATS when the combined vision filter
 * was split. Honour the old name rather than ignoring it - a config silently
 * dropped on the floor is how a threshold reverts to its default unnoticed.
 */
const atsThreshold = (): number => {
  const old = process.env['THRESHOLD_VISION'];
  if (old !== undefined && old !== '' && process.env['THRESHOLD_ATS'] === undefined) {
    process.stderr.write(
      '[WARN] THRESHOLD_VISION is renamed to THRESHOLD_ATS. Using it for now; rename it in .env.\n',
    );
    return num('THRESHOLD_VISION', 0.7);
  }
  return num('THRESHOLD_ATS', 0.7);
};

const bool = (key: string, fallback: boolean): boolean => {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
};

export interface Config {
  /**
   * Chat models, split by cost.
   *
   * - `pro`   the careful one. HallucinationChecker uses it.
   * - `flash` the cheap one. AiGeneratedChecker uses it.
   * - `vision` must accept images. ONLY LayoutChecker uses it. DeepSeek
   *   REJECTS images at the API schema level, so a DeepSeek model here makes
   *   that one filter skip - everything else still runs. Use Gemini for it.
   */
  readonly models: {
    readonly pro: string;
    readonly flash: string;
    readonly vision: string;
  };
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
   * Swaps strict grading for lenient prompts and bounds. Massively relaxes
   * the fabrication checks - use with caution.
   */
  readonly noShame: boolean;
  /**
   * File name of the CV inside the run folder. Accepts static text and the
   * placeholders {date} {time} {company} {position} {lang}, plus the aliases
   * {company_slug} and {position_slug}. See `output-path.ts`.
   *
   * The run FOLDER name is fixed and is not templated: the operator only needs
   * control over the file a recruiter receives.
   */
  readonly cvNameTemplate: string;
  readonly keyword: {
    /** sklearn `max_features` for the job-text vectorizer. */
    readonly maxFeatures: number;
    /** TF-IDF weight above which a term counts as significant. Strict >. */
    readonly cutoff: number;
    /** How many missing keywords to name in the failure message. */
    readonly maxMissingDisplay: number;
  };
  readonly optimizer: {
    /**
     * How many times the generator may be told to try again when it skips or
     * fails check_content_length.
     */
    readonly retries: number;
    /**
     * Cap on tool-call steps inside one attempt. The page-fit loop can need
     * many rounds under tight constraints.
     */
    readonly maxSteps: number;
  };
  readonly resume: {
    /**
     * A 2-page CV whose second page holds less than this many characters is
     * treated as page-1 overflow rather than a genuine second page.
     */
    readonly page2OverflowChars: number;
    /** Char target passed to the generator. Soft guidance only. */
    readonly targetChars: number;
    /** Word target passed to the generator. Soft guidance only. */
    readonly targetWords: number;
  };
  readonly thresholds: {
    readonly keyword: number;
    readonly vector: number;
    readonly hallucination: number;
    readonly aiGenerated: number;
    /** Minimum weighted ATS score. LayoutChecker has no threshold: it is binary. */
    readonly ats: number;
  };
  readonly logLevel: string;
}

export const loadConfig = (): Config => {
  loadEnvFile();
  // `deepseek-chat` answers, but it is not in the /v1/models list. Name a real
  // model instead. The list holds deepseek-v4-pro and deepseek-v4-flash.
  const flash = str('FLASH_MODEL', 'deepseek/deepseek-v4-flash');
  return {
    models: {
      pro: str('PRO_MODEL', 'deepseek/deepseek-v4-pro'),
      flash,
      // Defaults to Gemini, NOT to `flash`. DeepSeek rejects images at the API
      // schema level, so a DeepSeek model here makes LayoutChecker skip every
      // time. This needs GEMINI_API_KEY. Set VISION_MODEL to the flash model if
      // you would rather not use a second provider - LayoutChecker then skips
      // and says so, and no other filter is affected.
      vision: str('VISION_MODEL', 'gemini/gemini-3.5-flash'),
    },

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
    // No personal name in the default - that belongs in the operator's own .env.
    cvNameTemplate: str('CV_NAME_TEMPLATE', 'CV.{company}.{position}.pdf'),

    optimizer: {
      retries: num('OPTIMIZER_RETRIES', 5),
      maxSteps: num('OPTIMIZER_MAX_STEPS', 100),
    },

    keyword: {
      maxFeatures: num('KEYWORD_TFIDF_MAX_FEATURES', 200),
      cutoff: num('KEYWORD_TFIDF_CUTOFF', 0.1),
      maxMissingDisplay: num('KEYWORD_MAX_MISSING_DISPLAY', 10),
    },

    resume: {
      page2OverflowChars: num('RESUME_PAGE2_OVERFLOW_CHARS', 300),
      targetChars: num('RESUME_TARGET_CHARS', 4500),
      targetWords: num('RESUME_TARGET_WORDS', 520),
    },

    thresholds: {
      keyword: num('THRESHOLD_KEYWORD', 0.25),

      // NOT CALIBRATED. A cosine threshold belongs to one embedding model at
      // one dimension count. A different model has a different distribution, so
      // a number measured elsewhere does not transfer.
      // NaN makes every comparison false, so the filter fails loudly until this
      // is measured. Do not replace it with a guess - see docs/design-notes.md.
      vector: num('THRESHOLD_VECTOR', Number.NaN),

      hallucination: num('THRESHOLD_HALLUCINATION', 0.9),
      aiGenerated: num('THRESHOLD_AI_GENERATED', 0.4),
      ats: atsThreshold(),
    },

    logLevel: str('LOG_LEVEL', 'info'),
  };
};
