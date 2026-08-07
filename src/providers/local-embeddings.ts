import { Worker } from 'node:worker_threads';
import type { Config } from '../config.ts';
import type { EmbeddingProvider } from './embeddings.ts';
import type { UnsentRequest, WorkerRequest, WorkerResponse } from './embedding-protocol.ts';

/**
 * Host side of the local embedding worker.
 *
 * Owns the worker lifecycle and correlates request/response by id. The worker
 * is spawned lazily on first use so `cv-optimizer --help` does not pay for a
 * model load.
 */
export const localEmbeddings = (config: Config): EmbeddingProvider => {
  const { model, dimensions: dims, maxInputTokens } = config.embedding;

  let worker: Worker | null = null;
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (v: number[][] | number | null) => void; reject: (e: Error) => void }
  >();

  const start = (): Worker => {
    if (worker !== null) return worker;
    // tsc rewrites .ts to .js in import specifiers, but NOT inside
    // new URL() calls. Detect at runtime so the worker loads from both
    // `node src/cli.ts` (source) and `node dist/cli.js` (build).
    const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
    const w = new Worker(new URL(`./embedding.worker${ext}`, import.meta.url), {
      workerData: { model, dimensions: dims, maxInputTokens },
    });
    w.on('message', (res: WorkerResponse) => {
      const slot = pending.get(res.id);
      if (slot === undefined) return;
      pending.delete(res.id);
      if (res.ok) slot.resolve(res.data);
      else slot.reject(new Error(res.error));
    });
    w.on('error', (err: Error) => {
      for (const slot of pending.values()) slot.reject(err);
      pending.clear();
      worker = null;
    });
    w.on('exit', (code: number) => {
      const err = new Error(`embedding worker exited with code ${code}`);
      for (const slot of pending.values()) slot.reject(err);
      pending.clear();
      worker = null;
    });
    worker = w;
    return w;
  };

  const send = (req: UnsentRequest): Promise<number[][] | number | null> => {
    const w = start();
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      w.postMessage({ ...req, id } as WorkerRequest);
    });
  };

  return {
    model,

    prefetch: async () => {
      await send({ type: 'prefetch' });
    },

    dimensions: async () => {
      const d = await send({ type: 'dims' });
      if (typeof d !== 'number') throw new Error('worker returned a non-numeric dimension');
      return d;
    },

    embed: async (texts) => {
      if (texts.length === 0) return [];
      const v = await send({ type: 'embed', texts });
      if (!Array.isArray(v)) throw new Error('worker returned a non-array embedding result');
      return v;
    },

    close: async () => {
      if (worker === null) return;
      await worker.terminate();
      worker = null;
    },
  };
};
