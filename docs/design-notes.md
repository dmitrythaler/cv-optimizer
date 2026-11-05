# Design notes

Why this codebase is shaped the way it is. Every rule below came from a real
failure, and every number below was measured, not guessed.

Read this before changing a threshold, a prompt, or a filter's error handling.

---

## 1. Five rules, and the failures behind them

### A filter that cannot run must say so

A filter whose `except` branch returns `passed: true, score: 1.0` is
indistinguishable from a filter that is working perfectly. That is not a
theoretical risk: an embedding filter once scored exactly `1.00` on every
iteration of every job for months, because its API key was missing and every
call returned HTTP 401. The error text went into an `issues` array that is only
surfaced for _failing_ filters, and this one always reported success.

**Rule:** a filter that cannot run returns `skipped()` with a `NaN` score, and
the skip is logged at WARN. Never encode failure as a passing score.

### A broken provider must not read as a bad CV

The same rule in the other direction, and it cost a whole batch.

On 2026-11-05 the Gemini prepay balance hit zero. `LayoutChecker` threw
`AI_APICallError: Your prepayment credits are depleted` on every call.
`registry.ts` turned each throw into `score 0.0, passed: false`, on the sound
rule that a bug in a filter must not read as approval. The result:

| what happened                                                | why                                |
| ------------------------------------------------------------ | ---------------------------------- |
| no iteration could pass                                      | one filter always reported `false` |
| all 3 iterations ran, for all 12 jobs                        | `if (passed) break` never fired    |
| every extra round paid for a generate step                   | the CV could not be graded anyway  |
| the run reported `FAILED filters: AtsChecker, LayoutChecker` | it read as a verdict on the CV     |

The worst single case: Braver IT (Media). Iteration 2 passed the other seven
filters at ATS `0.756`. Iteration 3 scored ATS `0.606`. The loop filed
iteration 3, because `filed` is the last iteration.

That filing rule is **not** the bug, and it was not changed. When a CV passes,
the loop breaks and the last iteration _is_ the passing one. The rule only
misbehaves when a pass has been made impossible.

**Rule:** an error that comes from the provider ends the run. It does not grade
the CV, and it does not buy another iteration. `providerFault()` names it,
`ProviderUnavailableError` carries it, and `optimize` exits **3**, never 2 — a
caller that reads 2 as "the CV failed" would drop the job over an empty wallet.

Two guards keep the classifier honest:

- it is consulted for **thrown errors only**, never for a filter's `issues`;
- every pattern must be wording a CV cannot contain. A Zod error echoes the
  model's own output, so CV text reaches the classifier. A plain `/billing/` or
  `/rate limit/` pattern would end a run over a bullet about a billing system.
  Transport conditions are matched by HTTP status (401, 402, 403, 429), which no
  document can imitate.

A rate limit is transient, so ending a long run over one looks harsh. It is
still the cheap choice: the AI SDK already retried before it threw, and the
alternative pays for another generate step and grades nothing.

### A score must not be rescaled into a prettier range

```
score = (similarity + 1) / 2   // "normalize cosine from [-1,1] to [0,1]"
```

Mathematically fine, practically wrong. Text embeddings essentially never
produce negative cosine, so real values live in `[0, 1]` and the transform
squashes them into `[0.5, 1.0]`. Against a `0.4` threshold, nothing can fail.

Measured on 768-dim `gemini-embedding-001`:

| input pair                     | raw cosine    | after `(x+1)/2` |
| ------------------------------ | ------------- | --------------- |
| CV vs 8 genuine JDs            | 0.669 – 0.706 | 0.835 – 0.853   |
| CV vs a sourdough bread recipe | **0.447**     | **0.723**       |

A bread recipe cleared the threshold.

**Rule:** thresholds compare against raw values. `score` is diagnostic;
`passed` is the decision. Nothing downstream averages or re-thresholds a score.

### A threshold belongs to the model it was measured against

A cosine threshold is a property of one embedding model at one dimension count.
Carrying one across models makes it meaningless.

**Rule:** `THRESHOLD_VECTOR` has no code default. It is `NaN`, so every
comparison is false and the filter fails loudly until someone measures it. See
§3. Changing `EMBEDDING_MODEL` — or its `dtype` — invalidates the number.

### A prompt is behaviour

A prompt edit changes what a filter does, and a passing test run says nothing
about it. A formatter once silently reformatted two prompt files, including
turning `<!DOCTYPE html>` into `<!doctype html>` in a template.

**Rule:** every prompt is pinned by a SHA-256 digest in a test, and
`templates/**` is excluded from the formatter. If a digest fails, that is the
point — change it deliberately and say so in the commit message.

---

## 2. Filter design notes

Priorities run 0–8. Parallel execution is the default; `--seq` stops at the
first failure and is for debugging. A filter that throws becomes a FAILED
result, never a skipped one.

There is deliberately **no** "skip the rest once something failed" branch. It
would need a filter with priority >= 100 and the highest here is 8, so the code
would be dead.

### ContentLengthChecker (0)

- The pipeline renders once and passes `pageCount` and `pageTexts` down. The
  filter does not render for itself.
- Two quirks are deliberate, not oversights:
  - the `>2 pages` message reads "must be 1 page" while the check permits 2.
    Stale wording, correct behaviour.
  - a page 2 with **zero** characters passes. Only a page 2 holding _some_ text
    but less than `RESUME_PAGE2_OVERFLOW_CHARS` counts as overflow.
- `RESUME_PAGE2_OVERFLOW_CHARS` is 5000 in practice, not the 1000 a naive
  reading suggests.

### DataValidator (1)

Checks resume HTML. There is no structured-resume mode; `OptimizedResume`
carries HTML only, so the branch that would validate contact fields and
experience entries has nothing to check. If that mode is ever added, add the
branch with it.

### HallucinationChecker (3)

- Uses the `pro` model. It is the one filter where a wrong answer costs the most.
- `passed` is computed from the score against the threshold, and both are
  reported. The lenient bound is a fixed 0.6; strict mode is configurable.
- The content fallback chain is `html` -> structured data -> `"(no content)"`.

### KeywordMatcher (4)

Deterministic, free, no API — and it caught the one genuine domain mismatch that
both the embeddings and the vision model missed. Worth its place.

`src/text/tfidf.ts` reimplements one specific scikit-learn `TfidfVectorizer`
configuration in ~30 lines. The subtleties are all in tokenization (`Node.js`
must stay one token), the 318-word stop list, and sublinear TF. Scores agree
with the reference to within 1e-9 across all nine JDs in the corpus.

**`missing_keywords` ordering is deterministic here, by design.** A set-based
implementation in a language with per-process string hash randomization gives a
different order every run. That order reaches the optimizer as feedback, so
retries stop being reproducible. This build sorts.

### AtsChecker (5) and LayoutChecker (8)

**These were one filter, and splitting them removed a real trap.**

The combined filter made one model call that returned two unrelated judgements,
then multiplied them:

```
score = looks_professional ? atsScore : 0.0
```

So **a 0.00 never meant "the ATS rejected you"**. It meant the visual half said
no and the ATS numbers were thrown away. A dropped page image therefore looked
exactly like a terrible CV, which is how a plumbing fault hid for weeks.

**The measurements that settled it**, over 26 recorded evaluations:

|                                                  |                     |
| ------------------------------------------------ | ------------------- |
| `looks_professional: false` fired                | **0 times of 26**   |
| the visual half was the sole cause of a failure  | **4 of 6 failures** |
| issues raised that were about how the page LOOKS | **0 of 15**         |

Every issue it ever produced was a text judgement — "Missing required skill:
Redis", "No education section listed". Meanwhile the same CV against the same
job scored **0.57, 0.63 and 0.82** across three runs, crossing the threshold in
both directions. An aesthetic opinion that never fires, cannot be reproduced,
and can veto a good CV is not a filter; it is noise with authority.

Note also that an ATS parses TEXT. Grading ATS fit from a picture of the page is
less faithful to the thing being simulated, not more — and it dragged in a
second vendor, because DeepSeek cannot accept images at all (§3).

So:

- **`AtsChecker`** — text only, cheap model, no image, no second vendor. Keeps
  `disqualified`, which is genuinely valuable and is itself a text judgement.
  The score is **never zeroed out**: what it computed is what it reports.
  Weights sum to 1.0: keyword 0.25, experience 0.175, education 0.075,
  overall_fit 0.50. Half the score is one holistic judgement. Passing needs the
  score at or above threshold AND `!disqualified`.
- **`LayoutChecker`** — image only, one narrow question: is the page broken?
  Binary, like the deterministic filters. It never sees the job. `broken: true`
  with an empty defect list is treated as not broken and logged, because a
  filter that can veto a run must not do so on an unevidenced claim.

Two guards stay on the image half:

- **The provider cannot accept images** -> `skipped()`, NaN score, WARN log. A
  configuration fault is not a verdict about the CV, and it does not block.
- **No rendered page image** -> a real failure. A CV that will not render is
  broken.

Leave `VISION_MODEL` pointing at a provider without image support and you lose
exactly one filter, loudly. Everything else, including the ATS screening, keeps
running on one provider.

### VectorSimilarityMatcher (6)

**Calibrated 2026-08-04, `Xenova/bge-m3` @ 1024 dims**, via
`cv-optimizer calibrate-vector ../cv.md ../applications`:

| set                              | cosine        |
| -------------------------------- | ------------- |
| 21 real job descriptions         | 0.794 – 0.898 |
| control: sourdough bread recipe  | 0.498         |
| control: wrong stack (Java role) | 0.542         |

Separation 0.252, so `THRESHOLD_VECTOR=0.67`, the midpoint of the gap.

The local model beats the hosted one it replaces on both measures that matter:

| model                | separation | spread among real jobs |
| -------------------- | ---------- | ---------------------- |
| gemini-embedding-001 | 0.222      | 0.037                  |
| bge-m3 (local)       | **0.252**  | **0.104**              |

A ~3x wider spread among genuine jobs means it discriminates between them, not
merely between "software" and "not software".

It still misses one true domain mismatch: a computational-geometry role that
TF-IDF correctly flags at 0.31 scores 0.867 here, mid-pack. Whole-document
embedding averages that away. Chunked embedding is the upgrade if
per-requirement signal is ever needed.

**Operational findings, both learned by hitting them:**

- **`onnxruntime-node` can only load once per process.** A second embedding
  worker in the same process dies with `ERR_DLOPEN_FAILED`. Concurrent jobs must
  share one `EmbeddingProvider`. See ADR 0002.
- **Cache location matters.** Transformers.js defaults to
  `node_modules/@huggingface/transformers/.cache`, which `pnpm install` prunes.
  Pinned to `.cache/models/` via `env.cacheDir`. A second `pull-model` then
  takes 2.4s instead of 9 minutes.
- **Over-long input is refused, not truncated.** The tokenizer is loaded purely
  to check length first. Truncation would embed half a CV and return a confident
  number — exactly the failure mode this project exists to prevent.
- The download is ~2.2 GB because Transformers.js defaults to fp32 here. A
  quantized `dtype` would cut that with little effect on cosine, but the
  threshold is dtype-specific, so switching means re-running `calibrate-vector`.

### AiGeneratedChecker (7)

- **The score is inverted.** The model reports `ai_probability`; the filter
  reports `1 - p`, because every filter uses "high is good".
- **`is_ai_generated` is deliberately ignored.** The prompt sets the flag above
  0.5 while the threshold fails below 0.4, so a probability of 0.55 sets the flag
  and still passes. The score decides.
- `noShame` halves the threshold, 0.4 -> 0.2.

---

## 3. Models

| filter               | model    |
| -------------------- | -------- |
| HallucinationChecker | `pro`    |
| AiGeneratedChecker   | `flash`  |
| AtsChecker           | `flash`  |
| LayoutChecker        | `vision` |

`VISION_MODEL` defaults to Gemini, **not** to `flash`.

**The DeepSeek API cannot accept an image. Measured, not assumed.** Tested
against `api.deepseek.com` on 2026-08-04 with a real PNG:

| attempt                                       | result                                             |
| --------------------------------------------- | -------------------------------------------------- |
| `image_url` content part                      | 400 `unknown variant 'image_url', expected 'text'` |
| `image` content part                          | 400 same error                                     |
| `input_image` content part                    | 400 same error                                     |
| `/beta` endpoint                              | 400 same error                                     |
| model ids `deepseek-vl`, `vl2`, `v4-vision` … | 400 same error                                     |
| text only, same key                           | 200                                                |

The error does not change with the model id, even for ids that do not exist, so
the request schema has no image variant and the rejection happens before model
dispatch. The DeepSeek **app** has a vision mode; the public API has not
followed. `@ai-sdk/deepseek` 3.0.21 is current, so no client upgrade changes it.

Gemini works — verified end to end: a 64x64 blue PNG, and the model answered
`{"colour":"blue"}`.

Consequence: point `VISION_MODEL` at a DeepSeek model and LayoutChecker skips
every time, and says so. It does not quietly grade the text alone. Since the
split, that costs one narrow check rather than the whole ATS screening.

Also: `deepseek-chat` answers but is not in `/v1/models`. Name a real model.
Neither DeepSeek nor Anthropic offers an embeddings endpoint — verified,
`POST /v1/embeddings` returns 404 while `/v1/chat/completions` returns 200 on
the same key. Chat and embeddings will always be two different vendors, which
is part of why embeddings run locally.

---

## 4. The renderer

Chromium through Playwright. The page count, the per-page text and the page
image all come from the **produced PDF**, read back with poppler (`pdftotext`,
`pdftoppm`). None of them is guessed from the HTML — a vision filter that judges
a page the model never saw fails silently.

`templates/resume_wrapper.html` sets `size: letter` with `0.4in` margins;
`preferCSSPageSize` tells Chromium to obey it.

**CSS `letter-spacing` breaks name extraction, and the name is the one field an
ATS must read.** Chromium bakes letter-spacing into wide glyph gaps, and a PDF
text extractor then inserts spaces between the letters.

Measured on the shipped template:

| name                | 1.2pt | 1.5pt | 2pt   | 2.5pt |
| ------------------- | ----- | ----- | ----- | ----- |
| `Jonathan Dowerton` | ok    | SPLIT | SPLIT | —     |
| `John Dowerton`     | ok    | SPLIT | ok    | —     |
| `John Dow`          | ok    | ok    | ok    | ok    |

**Note the shape of that table.** The effect is name-dependent and **not
monotonic** — it turns on the glyph gap against the font's own space width for
those exact letters. So a value is not safe merely because one short name
survives it. `1.2pt` held for every name measured, which is why the template
uses it. Both `pdftotext` and `pdfjs-dist` agree, so it is not an artefact of
one extractor.

`.section-title` uses 1pt and is unaffected. Two tests pin this: one checks the
shipped template, one pins both ends of the threshold with a long name, because
a short one cannot show the failure.

---

## 5. The generator and the loop

The generator is the one part of the pipeline that **is** an agent: the model
calls tools, reads the results and revises. That is right here, because the
model cannot know the page count without rendering, so it has to be able to ask.

The pipeline around it is a plain loop with no model in the control flow. See
ADR 0001.

- **The retry is an explicit loop**, not a framework output validator. The
  generator must call `check_content_length(html)` before returning; if it does
  not, it is told so and asked again, up to `OPTIMIZER_RETRIES`.
- **`preview_resume` is deliberately absent.** It would hand the model an image,
  and the generator runs on DeepSeek. See §3.
- **`filed` is the LAST iteration, not the best one.** Nothing tries to pick a
  winner. Every iteration is returned and written to the run folder so a human
  can look back. An earlier draft invented a "fewest failures" heuristic; it was
  removed, because a heuristic that silently prefers a different document is the
  kind of thing nobody notices.
- A generator that never converges ends the run cleanly and keeps what earlier
  iterations produced. A render failure fails that iteration and the loop
  continues.

**Watch one interaction.** A keyword score rising while the hallucination score
falls means the optimizer has started inventing experience to match the job's
vocabulary. That is a real, observed failure mode — a run once added React
Router, TanStack Query, Redis, Headless CMS and WCAG to a Skills section to
close a gap, and HallucinationChecker caught it at 0.75. Prefer the earlier
iteration when that pattern appears.

---

## 6. Job intake

Two strategies, best first:

1. **`job-ld.ts`** reads the schema.org `JobPosting` from the page's JSON-LD.
   This is the posting itself, so there is nothing to strip and nothing to strip
   by mistake, and it works in any language. Nearly every serious board
   publishes it, because Google requires it for Google Jobs indexing.
2. **`job-text.ts`** is the fallback: cut the trailer at a "similar offers"
   heading, then drop navigation and legal boilerplate line by line.

The fallback is a word list, so it only works for the languages someone added.
Measured on a real justjoin.it page: 609 lines fetched, the posting was lines
96–250, and cleaning removed 54%. Measured on a German xing.com page: the word
lists barely dented it, while JSON-LD returned 2232 clean characters out of
292 KB of HTML. That gap is why strategy 1 exists.

This matters beyond tidiness. KeywordMatcher and VectorSimilarityMatcher score
the CV against this text, so a competitor's posting left in a "similar offers"
list pulls the scores toward the wrong job.

Guards worth keeping:

- A JSON-LD description under 300 characters is treated as a search-card stub
  and rejected in favour of the full page.
- A JSON-LD block that will not parse is skipped, not fatal.
- If the word-list cleaner would leave under 400 characters, it hands back the
  raw text and says so. An empty JD passed down the pipeline is the fail-quiet
  pattern this project exists to remove.
- `optimization.json` records which strategy ran, under `job.source.strategy`.
