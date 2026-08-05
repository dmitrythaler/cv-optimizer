/**
 * Embedding worker.
 *
 * Runs local model inference off the main thread. Inference and tokenization
 * are CPU-bound and would otherwise block the event loop while the rest of the
 * pipeline is waiting on chat API calls.
 *
 * This is the ONLY place a worker is used. Everything else in the pipeline is
 * I/O-bound and belongs on the main thread.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { AutoTokenizer, env, pipeline } from '@huggingface/transformers';
import type { WorkerInit, WorkerRequest, WorkerResponse } from './embedding-protocol.ts';

const init = workerData as WorkerInit;

// Cache model weights in the project, NOT under node_modules (the library
// default). A `pnpm install` prunes node_modules, which would silently throw
// away a multi-hundred-megabyte download that `model:pull` exists to make
// once. `.cache/` is gitignored.
env.cacheDir = new URL('../../.cache/models/', import.meta.url).pathname;

if (parentPort === null) {
  throw new Error('embedding.worker.ts must be run as a worker thread');
}
const port = parentPort;

type Extractor = Awaited<ReturnType<typeof pipeline<'feature-extraction'>>>;
type Tokenizer = Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>;

let extractor: Extractor | null = null;
let tokenizer: Tokenizer | null = null;

/** Loads the model once. First call downloads and caches it. */
const load = async (): Promise<{ extractor: Extractor; tokenizer: Tokenizer }> => {
  if (extractor === null || tokenizer === null) {
    // The tokenizer is loaded separately so input length can be checked before
    // inference, rather than letting the pipeline truncate silently.
    tokenizer = await AutoTokenizer.from_pretrained(init.model);
    extractor = await pipeline('feature-extraction', init.model);
  }
  return { extractor, tokenizer };
};

/**
 * Refuses over-long input instead of letting the tokenizer truncate it.
 *
 * A CV embedded from only its first N tokens yields a plausible-looking number
 * computed from half the document - the same class of silent wrongness that
 * is what keeps a filter broken and quiet. Better to fail loudly.
 */
const assertFits = (tok: Tokenizer, texts: readonly string[]): void => {
  texts.forEach((text, i) => {
    const { input_ids } = tok(text);
    const n = Number(input_ids.dims[input_ids.dims.length - 1] ?? 0);
    if (n > init.maxInputTokens) {
      throw new Error(
        `input ${i} is ${n} tokens, over the ${init.maxInputTokens} limit for ` +
          `'${init.model}'. Truncating would embed only part of the document, so ` +
          `this is refused rather than silently mismeasured.`,
      );
    }
  });
};

const embed = async (texts: readonly string[]): Promise<number[][]> => {
  const { extractor: ex, tokenizer: tok } = await load();
  assertFits(tok, texts);

  // Mean pooling + L2 normalization is the standard sentence-embedding recipe
  // and what the hosted APIs return, so cosine values stay comparable.
  const out = await ex([...texts], { pooling: 'mean', normalize: true });
  return out.tolist() as number[][];
};

/** Force the model to load (and download, first time) without embedding anything. */
const prefetch = async (): Promise<null> => {
  await load();
  return null;
};

const dimensions = async (): Promise<number> => {
  const [vector] = await embed(['dimension probe']);
  if (vector === undefined) throw new Error('embedding returned no vectors');
  return vector.length;
};

port.on('message', (req: WorkerRequest) => {
  const run = async (): Promise<WorkerResponse> => {
    try {
      switch (req.type) {
        case 'embed':
          return { id: req.id, ok: true, data: await embed(req.texts) };
        case 'dims':
          return { id: req.id, ok: true, data: await dimensions() };
        case 'prefetch':
          return { id: req.id, ok: true, data: await prefetch() };
      }
    } catch (err: unknown) {
      return { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };
  void run().then((res) => {
    port.postMessage(res);
  });
});
