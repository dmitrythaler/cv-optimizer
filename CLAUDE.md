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
  output-path.ts         run folder name + CV_NAME_TEMPLATE
  run-output.ts          writes the run folder
docs/
  architecture.md        how the pieces fit
  filters.md             the filter roster and thresholds
  porting-notes.md       what the Python original got wrong - READ THIS
  adr/                   architecture decision records
```

## Output

One run writes one folder:

```
output/20260805-0912-link_group-full_stack_engineer/
  jd.txt                the posting, fetched and cleaned
  Dmitry.Thaler.CV.link_group.full_stack_engineer.pdf   <- CV_NAME_TEMPLATE
  iteration_1.pdf   iteration_1.png
  iteration_2.pdf   iteration_2.png
  optimization.json     every filter score, per iteration
  errors.log            only when something went wrong
```

`optimize` takes a URL in place of a file. It fetches the posting itself, and
`jd.txt` is written by `prepareRun` BEFORE the loop starts, so a run that dies
twenty minutes in does not also lose the text it was working from.

`job-text.ts` strips the page furniture. Measured on a real justjoin.it page:
609 lines in, the posting was lines 96-250, and cleaning removed 54%. It cuts
the trailer at a "similar offers" heading and drops navigation and legal
boilerplate line by line. It keeps the head of the page, which holds the title,
company and salary the parser needs. If cleaning would leave too little, it
hands back the raw text and says so rather than passing an empty JD down the
pipeline.

The folder name is fixed and holds no personal name. Only the CV file name is
templated, because that is the name a recruiter sees once the file leaves the
folder. An unknown placeholder in `CV_NAME_TEMPLATE` stops the run.

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
