# 2. Embeddings run locally, in a worker thread

Date: 2026-08-03

## Status

Accepted. Supersedes the hosted-embedding default inherited from the Python
version.

## Context

The Python original called a hosted embedding API. That filter was dead for two
months because the API key was never configured and the failure path returned a
passing score. See `docs/porting-notes.md`.

The workload is small: two short documents per iteration, roughly 20 embeddings
per batch of eight jobs.

## Decision

Embeddings run **locally**, via an ONNX model, inside a **worker thread**.
No hosted embedding provider, no API key.

The worker is the only one in the codebase. Everything else stays on the main
thread.

## Rationale

**Why local.** It removes an entire failure class. No key to forget, no 401, no
rate limit, no network flake, and identical input gives identical output — which
is what makes a threshold regression detectable at all. At 20 embeddings per
batch the cost argument for a hosted API doesn't exist.

**Why a worker.** Inference and tokenization are CPU-bound. Left on the main
thread they would block the event loop while the rest of the pipeline is waiting
on chat API calls. This is the one genuinely CPU-bound step in the tool.

**Why not workers or child processes elsewhere.** The rest is I/O-bound — HTTP
out, wait, HTTP back. Node's event loop handles that concurrently in one
process; a concurrency-limited `Promise.all` is enough. The Python version
needed separate OS processes largely because of the GIL, which does not apply
here.

## Consequences

- **The inherited threshold is invalid.** `0.55` was calibrated against hosted
  `gemini-embedding-001` at 768 dimensions. A different model has a different
  cosine distribution, so the number does not transfer. `THRESHOLD_VECTOR`
  therefore defaults to `NaN`, which makes every comparison false and forces the
  filter to fail loudly until someone measures it. Do not replace it with a
  guess.
- **Model choice constrains the corpus.** Context window matters: a 2-page CV
  runs past 512 tokens, and a model that silently truncates would embed half a
  document and return a plausible number. Some job descriptions are in Polish,
  so the model must be multilingual. Hence `bge-m3` (multilingual, 8192) as the
  default over the smaller English-only options.
- **The model is downloaded as an explicit step, never lazily mid-run.**
  `pnpm model:pull` (`cv-optimizer pull-model`) loads the model without
  embedding anything, so the weights are fetched and cached up front. bge-m3 is
  a ~560M parameter model; paying for that download inside the first optimize
  run would look like a hang, and would happen while an iteration is already
  part-way through. After the pull, operation is fully offline.
  Implemented as a `prefetch` message on the worker protocol, so it exercises
  exactly the same load path the real embedding calls use.
- Recalibration is now a required step whenever the embedding model changes.
  That is a feature — it was the absence of this discipline that let the Python
  filter ship broken.
