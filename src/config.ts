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
  readonly thresholds: {
    readonly keyword: number;
    readonly vector: number;
    readonly hallucination: number;
    readonly aiGenerated: number;
    readonly vision: number;
  };
  readonly logLevel: string;
}

export const loadConfig = (): Config => ({
  chatModel: str('CHAT_MODEL', 'deepseek/deepseek-chat'),

  embedding: {
    // bge-m3: multilingual (some job descriptions are in Polish) and an 8192
    // token window, which a 2-page CV needs. Verify the exact ONNX repo id
    // before first run - see docs/porting-notes.md.
    model: str('EMBEDDING_MODEL', 'Xenova/bge-m3'),
    dimensions: num('EMBEDDING_DIMENSIONS', 0),
    maxInputTokens: num('EMBEDDING_MAX_INPUT_TOKENS', 8192),
  },

  maxIterations: num('MAX_ITERATIONS', 3),

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
