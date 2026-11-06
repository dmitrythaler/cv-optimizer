# CLAUDE.md

# cv-optimizer

Takes a CV and a job description,
generates a tailored CV as pandoc markdown, renders it with pandoc and
WeasyPrint, grades it with a set of filters, and retries until it
passes or runs out of iterations.

## Status

**Live.** The generator calls DeepSeek (pro and flash) and Gemini (vision).
Filters grade every iteration and feed failures back. Embeddings run locally
through ONNX in a worker thread. The tool is operational.

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
# Standalone. example.cv.md is committed, so this works in a fresh clone.
pnpm build && pnpm start optimize example.cv.md path/to/jd.txt

# Inside the job-crawling pipeline, where the crawler already wrote jd.txt.
pnpm build && pnpm start optimize ../input/cv.md ../applications/<job>/jd.txt

pnpm test
pnpm typecheck
pnpm build
pnpm fmt
```

**`pnpm start` RUNS `dist/`, NOT `src/`.** It is `node dist/cli.js`, so a source
edit does nothing until `pnpm build` runs. Always build first.

This is not a theoretical trap. On 2026-09-03 the whole renderer was swapped
from Chromium to pandoc, and the run afterwards passed every filter and printed
"PASSED - every filter agreed" — from three-week-old compiled code. Nothing in
the output said so. It was caught only by reading the PDF itself:

```bash
pdfinfo out.pdf | grep Producer     # WeasyPrint 69.0, not Skia/PDF
pdffonts out.pdf                    # CV-Carlito, not LiberationSans
```

`pnpm test` and `pnpm typecheck` read `src/` directly, so they pass while the
built CLI is stale. A green test run is NOT evidence that the CLI changed.

Check the artifact, never the exit code.

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
                         ATS screening reads TEXT; only LayoutChecker sees the page
  providers/llm.ts       chat/vision seam (remote)
  providers/provider-error.ts  tells a broken provider from a bad CV
  providers/embeddings.ts    embedding contract + cosine
  providers/local-embeddings.ts  host side: owns the worker
  providers/embedding.worker.ts  the ONLY worker - local ONNX inference
  providers/embedding-protocol.ts  messages shared by both sides
  render/pdf.ts          markdown -> PDF/text/PNG seam
  render/pandoc.ts       pandoc + WeasyPrint, styled by templates/cv.css
  output-path.ts         run folder name + CV_NAME_TEMPLATE
  run-output.ts          writes the run folder
docs/
  architecture.md        how the pieces fit
  filters.md             the filter roster and thresholds
  design-notes.md        why the thresholds and guards exist - READ THIS
  adr/                   architecture decision records
```

## Output

One run writes one folder:

```
output/20260805-0912-link_group-full_stack_engineer/
  jd.txt                the posting, fetched and cleaned
  John.Dow.CV.link_group.full_stack_engineer.pdf   <- CV_NAME_TEMPLATE
  iteration_1.pdf   iteration_1.png
  iteration_2.pdf   iteration_2.png
  optimization.json     every filter score, per iteration
  errors.log            only when something went wrong
```

`optimize` takes a URL in place of a file. It fetches the posting itself, and
`jd.txt` is written by `prepareRun` BEFORE the loop starts, so a run that dies
twenty minutes in does not also lose the text it was working from.

`fetch-job <url>` writes the same folder with `jd.txt` alone, and asks for no
output path. Both commands name the folder through `prepareRun`, so they cannot
disagree about where a posting belongs. It costs one flash call, because the
folder is named after the company and the role.

The posting is separated from the page in two steps, best first:

1. **`job-ld.ts`** reads the schema.org `JobPosting` from the page's JSON-LD.
   This is the posting itself, so there is nothing to strip and nothing to
   strip by mistake, and it works in ANY language. Nearly every serious board
   publishes it, because Google requires it for Google Jobs indexing.
2. **`job-text.ts`** is the fallback for pages with no JSON-LD. It cuts the
   trailer at a "similar offers" heading and drops navigation and legal
   boilerplate line by line. It is a word list, so it only works for the
   languages someone added - a German page kept nearly all of its junk, which
   is why step 1 exists. If cleaning would leave too little, it hands back the
   raw text and says so rather than passing an empty JD down the pipeline.

`optimization.json` records which strategy ran, under `job.source.strategy`.

The folder name is fixed and holds no personal name. Only the CV file name is
templated, because that is the name a recruiter sees once the file leaves the
folder. An unknown placeholder in `CV_NAME_TEMPLATE` stops the run.

## Design rules

These come from bugs that actually shipped. See `docs/design-notes.md` for the
full account.

1. **Never invent a passing score to mask an internal error.** A filter that
   cannot run must say so (`skipped()`), not return `1.0` and `passed: true`.
   That exact fallback hid a completely dead filter for two months.
   **The same holds in reverse: a broken PROVIDER is not a bad CV.** An empty
   wallet, a bad key or a refused call ends the run through
   `ProviderUnavailableError`, and `optimize` exits **3**, never 2. A filter
   exception that is NOT a provider fault stays a FAILED result, because a bug
   must not read as approval.
2. **`score` is diagnostic; `passed` is the decision.** Nothing downstream may
   average, aggregate or threshold on `score`.
3. **Do not rescale scores into a prettier range.** The original mapped cosine
   through `(x + 1) / 2`, which made its threshold unreachable — a bread recipe
   scored 0.72 against the CV and passed.
4. **Calibrate thresholds against measured data**, and record the measurement in
   `docs/design-notes.md`. Do not pick round numbers by feel.
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

## This repo stands alone, and it also has a host

**It is self-contained.** A fresh clone installs, typechecks, tests and builds
with nothing outside it. Nothing in `src/`, `test/` or CI reaches past the repo
root, and nothing may start to. The corpus is `example.cv.md` here; the JD
fixtures are in `test/`.

That rule was not free. Until 2026-11-06 a test read `../../cv.md`, which had
stopped existing, so the file died on load and took the suite red — and hid
four other failures behind it. A path that leaves the repo is a path that
breaks for everybody who is not sitting in the host checkout.

**It is also one stage of a job-crawling pipeline**, and that is where the
mileage is. In the host, a crawler judges a posting, fetches it, translates it
and writes `jd.txt` into a folder per job; this tool is then run against that
file, and the batch runner passes `-o <that folder>` so the run writes beside
the posting it came from. The host's state lives in `../results.json` and
`../applications/`, and `../task.md` describes it.

When this repo runs inside that host, these paths exist:

```bash
pnpm start optimize ../input/cv.md ../applications/<job>/jd.txt
```

Use them for manual runs and for calibration, never from a committed test.

**Prefer a text JD over a URL, in both worlds.** `optimize` accepts a URL and
will fetch and clean the page itself, but cleaning is the weakest step in the
chain: `job-ld.ts` reads schema.org JSON-LD when a board publishes it, and when
it does not, `job-text.ts` falls back to word lists that only cover the
languages somebody added. Give it text that is already extracted and already in
English and the whole run gets better. See `docs/design-notes.md`.
