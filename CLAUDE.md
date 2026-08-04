# CLAUDE.md

# cv-optimizer

TypeScript re-implementation of `../hr-breaker`. Takes a CV and a job description,
generates a tailored CV, grades it with a set of filters, and retries until it
passes or runs out of iterations.

## Status

**Backbone only.** The structure, types and CLI shell exist; the generator,
filters, providers and renderer are stubs that throw. Nothing calls a model yet.

## Stack

- Node >= 24 (current Active LTS), ESM, TypeScript strict
- Chat models are remote; **embeddings are local** (ONNX in a worker thread, no API key)
- Run source directly: `node src/cli.ts` (native type stripping, no ts-node/bundler)
- Build with plain `tsc`; `rewriteRelativeImportExtensions` turns the `.ts`
  import specifiers into `.js` on emit
- Tests: `node --test` (built in, no vitest)
- Format: `oxfmt`
- Package manager: pnpm

Relative imports carry a **`.ts`** extension. That is deliberate and required
for `node src/cli.ts` to work — do not "fix" them to `.js`.

## Commands

```bash
pnpm start -- optimize ../cv.md ../applications/<job>/jd.txt --dry-run
pnpm test
pnpm typecheck
pnpm build
pnpm fmt
```

## Layout

```
src/
  cli.ts                 arg parsing only, no logic
  index.ts               library exports
  config.ts              env -> Config, thresholds live here
  logger.ts              leveled stdout/stderr logging
  types.ts               domain types, provider-agnostic
  pipeline/orchestrator.ts   the generate/grade loop
  filters/               base contract + registry
  providers/llm.ts       chat/vision seam (remote)
  providers/embeddings.ts    embedding contract + cosine
  providers/local-embeddings.ts  host side: owns the worker
  providers/embedding.worker.ts  the ONLY worker - local ONNX inference
  providers/embedding-protocol.ts  messages shared by both sides
  render/pdf.ts          HTML -> PDF/text/PNG seam
docs/
  architecture.md        how the pieces fit
  filters.md             the filter roster and thresholds
  porting-notes.md       what the Python original got wrong - READ THIS
  adr/                   architecture decision records
```

## Design rules

These come from bugs that actually shipped in the Python version. See
`docs/porting-notes.md` for the full account.

1. **Never invent a passing score to mask an internal error.** A filter that
   cannot run must say so (`skipped()`), not return `1.0` and `passed: true`.
   That exact fallback hid a completely dead filter for two months.
2. **`score` is diagnostic; `passed` is the decision.** Nothing downstream may
   average, aggregate or threshold on `score`.
3. **Do not rescale scores into a prettier range.** The original mapped cosine
   through `(x + 1) / 2`, which made its threshold unreachable — a bread recipe
   scored 0.72 against the CV and passed.
4. **Calibrate thresholds against measured data**, and record the measurement in
   `docs/porting-notes.md`. Do not pick round numbers by feel.
5. **The pipeline has no agent in it.** The steps are fixed and there is nothing
   to decide at runtime. Keep it a plain loop — determinism and cheap
   parallelism are the whole point.
6. **A produced PDF is not a pass.** Always report the outcome from
   `outcome.passed`, never from "a file exists".
7. **One worker, for embeddings only.** That is the single CPU-bound step.
   Everything else is I/O-bound and stays on the main thread - no child
   processes, no worker pool. See ADR 0002.
8. **Changing the embedding model invalidates `THRESHOLD_VECTOR`.** It has no
   default on purpose; re-measure and write the numbers down.

## Parent project

`../hr-breaker` is the working Python reference. `../results.json` and
`../applications/` belong to the job-scanning side of the repo — see
`../task.md`. Use the real JDs under `../applications/*/jd.txt` as test fixtures.
