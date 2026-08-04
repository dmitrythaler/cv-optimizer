import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { localEmbeddings } from '../src/providers/local-embeddings.ts';
import { cosine } from '../src/providers/embeddings.ts';
import { loadConfig } from '../src/config.ts';

/**
 * Exercises the real local model in its worker thread.
 *
 * Skipped when the model is not cached, so a fresh clone does not fail on a
 * 2.2 GB download. Run `pnpm model:pull` first to enable these.
 *
 * ONE provider is shared by every test here, deliberately. `onnxruntime-node`
 * is a native addon that can only self-register ONCE per process: spawning a
 * second embedding worker in the same process fails with
 * "Module did not self-register / ERR_DLOPEN_FAILED". The pipeline must
 * likewise share a single provider across concurrent jobs. See ADR 0002.
 */
const config = loadConfig();
const cached = existsSync(
  new URL(`../.cache/models/${config.embedding.model}`, import.meta.url).pathname,
);
const opts = cached ? {} : { skip: 'model not cached - run `pnpm model:pull`' };

const shared = localEmbeddings(config);
after(() => shared.close());

test('embedding worker: loads the model and returns normalized vectors', opts, async () => {
  {
    const [a, b, c] = await shared.embed([
      'Senior Node.js backend engineer',
      'Experienced backend developer using Node.js',
      'sourdough bread baking',
    ]);
    assert.ok(a && b && c);
    assert.equal(a.length, 1024, 'bge-m3 produces 1024 dimensions');

    const norm = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
    assert.ok(Math.abs(norm - 1) < 1e-5, `vectors must be L2-normalized, got ${norm}`);

    // A paraphrase must sit clearly above unrelated text, or the filter is
    // measuring nothing.
    assert.ok(cosine(a, b) > cosine(a, c) + 0.15, 'paraphrase beats unrelated text');
  }
});

test('embedding worker: refuses input longer than the context window', opts, async () => {
  // Transformers.js would silently truncate. A CV embedded from only its first
  // N tokens yields a plausible number computed from half the document, which
  // is the class of silent wrongness this port exists to avoid.
  await assert.rejects(() => shared.embed(['x '.repeat(20000)]), /over the 8192 limit/);
});

test('embedding worker: reports the model dimension', opts, async () => {
  assert.equal(await shared.dimensions(), 1024);
});

test('embedding worker: close() is safe to call when nothing was started', async () => {
  // A provider that never spawned a worker must close cleanly - and must not
  // spawn one just to shut it down (that would trip the native-addon limit).
  const e = localEmbeddings(config);
  await e.close();
  await e.close();
});
