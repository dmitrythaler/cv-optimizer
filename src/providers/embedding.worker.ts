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
import type { WorkerInit, WorkerRequest, WorkerResponse } from './embedding-protocol.ts';

const init = workerData as WorkerInit;

if (parentPort === null) {
  throw new Error('embedding.worker.ts must be run as a worker thread');
}
const port = parentPort;

/**
 * TODO: load the ONNX model here, once.
 *
 *   const { pipeline } = await import('@huggingface/transformers')
 *   extractor = await pipeline('feature-extraction', init.model)
 *
 * Two things to get right, both of which bit the Python version:
 *  - Reject input over `init.maxInputTokens` instead of letting the tokenizer
 *    silently truncate. A CV embedded from its first 512 tokens produces a
 *    plausible number computed from half the document.
 *  - Do not catch inference errors and return a neutral vector. Let them
 *    propagate so the caller can report the filter as skipped.
 */
const embed = (_texts: readonly string[]): number[][] => {
  throw new Error(
    `embedding model '${init.model}' not loaded yet - see TODO in embedding.worker.ts`,
  );
};

const dimensions = (): number => {
  throw new Error(
    `embedding model '${init.model}' not loaded yet - see TODO in embedding.worker.ts`,
  );
};

port.on('message', (req: WorkerRequest) => {
  let res: WorkerResponse;
  try {
    res =
      req.type === 'embed'
        ? { id: req.id, ok: true, data: embed(req.texts) }
        : { id: req.id, ok: true, data: dimensions() };
  } catch (err: unknown) {
    res = { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  port.postMessage(res);
});
