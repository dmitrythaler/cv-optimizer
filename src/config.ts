import { existsSync } from 'node:fs';
import process from 'node:process';

/**
 * Load `.env` from the project root, once, before any setting is read.
 *
 * hr-breaker does the same with python-dotenv. Without it every entry point
 * would have to pass keys through by hand, and a caller that forgot would get
 * a confusing failure deep inside a provider. A real env var still wins - the
 * loader does not overwrite what is already set.
 */
const ENV_FILE = new URL('../.env', import.meta.url).pathname;
let envLoaded = false;
const loadEnvFile = (): void => {
  if (envLoaded) return;
  envLoaded = true;
  if (!existsSync(ENV_FILE)) return;
  try {
    process.loadEnvFile(ENV_FILE);
  } catch (err: unknown) {
    // Say so. A silently ignored .env is how a run ends up with no API key
    // and an error that points somewhere else entirely.
    process.stderr.write(
      `[WARN] could not read ${ENV_FILE}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
};

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
  /**
   * Chat models, split by cost as hr-breaker splits them.
   *
   * - `pro`   the careful one. HallucinationChecker uses it.
   * - `flash` the cheap one. AiGeneratedChecker uses it.
   * - `vision` must accept images. VisionChecker uses it. It falls back to
   *   `flash`, but note that DeepSeek REJECTS images at the API schema level,
   *   so a DeepSeek flash model makes VisionChecker skip. Use Gemini for it.
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
  readonly optimizer: {
    /**
     * How many times the generator may be told to try again when it skips or
     * fails check_content_length. hr-breaker's `optimizer_retries`.
     */
    readonly retries: number;
    /**
     * Cap on tool-call steps inside one attempt. hr-breaker's
     * `optimizer_request_limit`, which exists because the page-fit loop can
     * need many rounds under tight constraints.
     */
    readonly maxSteps: number;
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
      // schema level, so a DeepSeek vision model makes VisionChecker skip
      // every time. This needs GEMINI_API_KEY. Set VISION_MODEL to the flash
      // model if you would rather not use a second provider - the filter will
      // then skip, and say so.
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
  };
};
