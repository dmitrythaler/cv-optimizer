# Porting notes

Findings from the Python original (`../hr-breaker`) that the TypeScript version
must not repeat. Every item here is a bug that shipped and survived real use.

## 1. The fail-open filter that was never running

`VectorSimilarityMatcher` scored exactly `1.00` on every iteration of every job,
for months. It looked like a filter that always agreed.

Two stacked causes:

- `EMBEDDING_MODEL` pointed at `openrouter/google/gemini-embedding-001`, but
  `OPENROUTER_API_KEY` was never set. Every call returned HTTP 401.
- The `except` branch returned `passed: true, score: 1.0`. So a hard auth
  failure was indistinguishable from a perfect match.

It stayed invisible because the error text went into an `issues` array that only
gets surfaced for _failing_ filters — and this one always reported success.

**Rules taken from this:** a filter that cannot run reports `skipped()`, and any
skip is logged at WARN. Never encode failure as a passing score.

## 2. The unreachable threshold

The same filter computed:

```python
score = (similarity + 1) / 2   # "normalize cosine from [-1,1] to [0,1]"
```

Mathematically fine, practically wrong. Text embeddings essentially never
produce negative cosine, so real values live in `[0, 1]` and the transform
squashed them into `[0.5, 1.0]`. Against a `0.4` threshold, nothing could fail.

Measured proof, 768-dim `gemini-embedding-001`:

| input pair                     | raw cosine    | after `(x+1)/2` |
| ------------------------------ | ------------- | --------------- |
| CV vs 8 genuine JDs            | 0.669 – 0.706 | 0.835 – 0.853   |
| CV vs a sourdough bread recipe | **0.447**     | **0.723**       |

A bread recipe cleared a 0.4 threshold.

**Fix carried over:** use raw cosine, threshold `0.55`.

## 3. Calibration baseline

> **These numbers do NOT transfer to this project.** They were measured against
> hosted `gemini-embedding-001`; cv-optimizer embeds locally with a different
> model (ADR 0002), which has its own cosine distribution. They are recorded as
> a _method_, not as values to copy. `THRESHOLD_VECTOR` has no default until you
> repeat the measurement — see `filters.md`.

Reference figures, `gemini-embedding-001`, 768 dimensions, whole-document:

- Genuine CV/JD pair: **0.67 – 0.71**
- Unrelated text (a bread recipe): **~0.45**
- Threshold chosen between the clusters: **0.55**

The method is the transferable part: embed the real corpus, embed an off-topic
control, confirm the two form separate clusters, and put the threshold between
them. If they do not separate, the filter is not measuring anything useful and a
threshold will not rescue it.

Known limitation, not a bug: the spread between genuine jobs is only ~0.04, and
the one true domain mismatch in the corpus (a computational-geometry role)
scored 0.70 — near the top — while TF-IDF correctly flagged it at 0.31. Whole
document embedding averages away the detail. It works as a coarse "is this even
a software job" guard and nothing finer. Chunked embedding (JD requirements
against CV bullets) is the upgrade if real signal is ever needed.

## 4. The vision filter that grades the wrong thing

`LLMChecker` screenshots the rendered CV and asks a vision model whether it looks
professional. When the image fails to arrive, it does **not** error — it grades
the text extracted from the PDF instead, and reports confident nonsense:
"bullets detached from their companies", "contact line mangled". Inspecting the
actual render showed every complaint was false.

Its own feedback gave it away: _"the referenced resume image was not accessible
in this session, so the visual review was performed against the extracted text."_

A score of exactly **`0.00`** is the signature of the image not arriving.

The failure is **intermittent**. In one 6-way parallel batch the same CV scored
0.00 three times running; re-run alone a few days later it scored 0.81 and
passed. Suspected cause: `litellm_patch.py` monkey-patches
`LiteLLMModel._map_messages` globally on a shared class, which is exactly where
a race would appear under concurrent async use.

**Rules taken from this:** treat a missing render PNG as a hard error before the
model is ever called, and keep the vision seam free of global mutable patching.

## 5. Things that were fine and are worth keeping

- **TF-IDF keyword matching earns its place.** Deterministic, free, no API, and
  it caught the one genuine domain mismatch that both the embeddings and the
  vision model missed. `scikit-learn`'s `TfidfVectorizer` is the only real
  Python ML dependency in the whole tool, and it is ~30 lines to reimplement —
  but mind tokenization (`Node.js` as one token), stop words and sublinear TF,
  which is where the scores actually come from.
- **The retry loop with fed-back complaints works.** Watch the interaction
  though: keyword score rising while hallucination score falls is the optimizer
  starting to invent experience to match JD vocabulary. Prefer the earlier
  iteration when that happens.
- **Parallel filter execution** is the right default; sequential is for debugging.

## 6. Provider facts

- **DeepSeek has no embeddings endpoint.** Verified: `POST /v1/embeddings`
  returns 404 for every model name while `/v1/chat/completions` returns 200 on
  the same key. Chat and embeddings will always be two different vendors.
- Anthropic does not offer embeddings either.
- A local embedding model (Transformers.js, Ollama) is a serious option here.
  The workload is two short documents per iteration — roughly 20 embeddings per
  batch. Local removes auth failures, rate limits and non-determinism in one go.
  Mind the context window: `bge-small-en-v1.5` caps at 512 tokens and would
  silently truncate a 2-page CV. `nomic-embed-text-v1.5` and `bge-m3` handle
  8192 and are multilingual, which matters because some JDs are in Polish.

## 7. Deliberate deviations from the Python, filter by filter

Every difference is listed here. Behaviour is preserved unless stated.

### ContentLengthChecker (priority 0)

- **Rendering moved out of the filter.** `content_length.py` called
  `get_renderer().render(html)` itself, re-rendering a document the pipeline had
  already rendered. Here the pipeline renders once and passes `pageCount` and
  `pageTexts` down through `OptimizedResume`. Same verdicts, one render.
- **Quirks kept, not fixed** — these are behaviour callers may depend on:
  - the `>2 pages` message reads "must be 1 page" while the check permits 2.
    Stale wording, correct behaviour.
  - a page 2 with **zero** characters passes. Only a page 2 holding _some_ text
    below the overflow bound counts as spillover (`len > 0` guard in the original).
- **`estimate_content_length` is not ported.** It is imported by the Python
  filter and never called - dead code.
- **`resume_page2_overflow_chars` = 5000, not 1000.** The Python _code_ default
  is 1000, but hr-breaker's `.env` sets 5000, so 5000 is what actually runs.
  Effective behaviour wins.

### DataValidator (priority 1)

- **Only the HTML branch is ported.** `validate_resume_data()` validates a
  structured `ResumeData` object - contact fields, per-entry experience and
  education checks. This port has no structured-resume mode; `OptimizedResume`
  carries HTML only. If that mode is ever added, port that branch with it.
- **Regexes and message strings are identical**, including the `else if`: a
  missing `<header>` suppresses the separate "missing name" issue rather than
  reporting both.

### HallucinationChecker (priority 3)

- **Both prompts copied verbatim.** `STRICT_PROMPT` and `LENIENT_PROMPT` live in
  `src/prompts/hallucination.ts` and are byte-identical to
  `agents/hallucination_detector.py` (verified by SHA). The trailing space after
  "You are a resume verification specialist." is preserved via an explicit
  `${' '}` so no formatter can strip it, and a test pins it.
- **One behavioural fix, deliberate.** In the Python, `passed` is computed
  against a _hardcoded_ threshold (0.9 strict / 0.6 lenient) inside
  `detect_hallucinations()`, and the filter then overwrites the reported
  `threshold` from settings without recomputing `passed`. So changing
  `FILTER_HALLUCINATION_THRESHOLD` moved the displayed number but not the
  verdict. Here one threshold drives both. No visible difference today because
  hr-breaker's `.env` sets 0.9, matching the hardcode - but it would have
  surprised the first person to tune it. The lenient 0.6 bound stays hardcoded,
  as in the original.
- **`--no-shame` ported** as `NO_SHAME` / `config.noShame`.
- **Dependencies arrive via `FilterContext`, not constructed inside filters.**
  `chat` sits alongside `config` there. A filter that can build its own provider
  can also mask a misconfigured one - which is exactly how the vector filter
  died. This also keeps registration uniform: every filter is a plain object, so
  `cv-optimizer filters` can list them without a provider.
- **`targetLanguage` added to `FilterContext`**, mirroring the `language`
  argument the Python threads through `evaluate()`. Language names for the
  non-English prompt note come from `Intl.DisplayNames` rather than a lookup table.
- The Python's fallback chain for optimized content (`html` -> structured
  `data` -> `"(no content)"`) collapses to HTML-only here, since there is no
  structured-resume mode.

### KeywordMatcher (priority 4)

Scores match hr-breaker **exactly** - all nine JDs in the corpus agree to
within 1e-9, verified by running the Python's own `check_keywords()` over
`cv.md` and comparing (`test/fixtures.keywords.json`).

- **scikit-learn's `TfidfVectorizer` is reimplemented, not approximated.** Two
  properties of the exact configuration make that tractable:
  1. It is fitted on a **single document**. With `smooth_idf` (default) and one
     document, `idf = ln((1+1)/(1+1)) + 1 = 1` for every term, so tf-idf
     collapses to plain term frequency.
  2. `norm="l2"` then scales the count vector to unit length.

  So a term's weight is just `count / sqrt(sum of counts squared)`. Verified
  against sklearn fixtures in `test/tfidf.test.ts`.

- **The 318-word `ENGLISH_STOP_WORDS` list is copied verbatim** into
  `src/text/stopwords.ts`. It is idiosyncratic - it contains "system",
  "computer", "fire", "cry" - and every removal shifts every score, so it must
  not be tidied.
- **Tokenizer quirks preserved.** `(?u)\b[a-zA-Z][a-zA-Z0-9+#.-]*\b` means
  `Node.js` survives whole, `.NET` becomes `net` (a token must start with a
  letter), and **`C++` and `C#` both collapse to `c`** - the trailing `\b`
  cannot sit between `+` and a space, so the match backtracks to the bare
  letter. Tested.
- **Bigrams are formed after stop-word removal**, so "the lazy dog with a very
  good system" yields "lazy dog" then "dog good", bridging the removed words.

Two places where exact parity is impossible, both benign:

- **`max_features` tie-breaking.** When the cut lands inside a run of
  equally-frequent terms, sklearn breaks the tie with `(-tfs).argsort()` -
  numpy's _unstable_ quicksort, an artifact of introsort internals rather than a
  rule. On the real corpus 86 terms differ at that cliff, but every one is a
  count-1 term scoring ~0.04, far below the 0.1 significance cutoff, so none
  reach the score. The 23 significant terms are identical. This port breaks ties
  alphabetically.
- **`missing_keywords` ordering is non-deterministic in Python.**
  `significant_keywords` is a `set`, CPython randomizes string hashing per
  process, and the sort is stable - so it preserves an arbitrary order among
  equal-weight terms. Three consecutive runs of the same input produced three
  different orders, and where more than `maxMissingDisplay` terms tie, the
  displayed slice differs in _membership_ too. That text is fed back to the
  optimizer as iteration feedback, so hr-breaker's retries are not reproducible.
  **This port is deterministic**, which is a deliberate improvement rather than
  a parity break. Scores are unaffected.

### VisionChecker (priority 5) - `LLMChecker` in hr-breaker

`SYSTEM_PROMPT` is copied verbatim and verified byte-identical to
`agents/combined_reviewer.py` by SHA, in a test that reads the Python source
directly - so the prompt cannot drift without a test failure.

**Renamed.** `LLMChecker` described the implementation ("it calls an LLM") and
not the job; every other filter is named for what it checks. The string is
user-visible: it lands in `cv_failed_filters` in `../results.json`, where three
entries already read `LLMChecker`. Those stay as historical record; new runs
emit `VisionChecker`.

**The 0.00 mystery, solved.** The Python's scoring line is:

```python
score = ats_score if result.looks_professional else 0.0
```

A `0.00` therefore means `looks_professional=False` and nothing else - the ATS
numbers are computed and then thrown away. Combined with the page image failing
to reach the model (it then grades extracted PDF text, sees bullets trailing the
company list in text order, and says "bullets detached from their companies"),
this made a transport fault indistinguishable from an ugly CV. Every failure
looked identical because every failure _was_ the same number. Behaviour kept for
parity, and pinned by a test that asserts the discarded ATS score was excellent.

**Passing is a three-way AND**: `looks_professional && atsScore >= threshold &&
!disqualified`. Worth knowing that a CV can clear the ATS bar comfortably and
still fail on the visual flag alone.

**The ATS weights are lopsided**: `overall_fit` 0.50, `keyword` 0.25,
`experience` 0.175, `education` 0.075. Half the score is one holistic judgement.
`education` is scored at all, despite `cv.md` having no education section -
a standing drag on every run. Weights carried over unchanged; flagging as a
tuning candidate, not changing them.

**Two guards the Python does not have**, and the only behavioural additions:

- **Provider cannot do vision** -> `skipped()` plus a WARN, and no model call.
  This is a configuration fault, not a defect in the CV, and must not produce a
  verdict. hr-breaker conflated it with `looks_professional=false`.
- **No rendered page image** -> a real failure, matching hr-breaker (which
  returns `looks_professional=false, disqualified=true, page_count=0`). A CV
  that will not render is broken.

The provider layer refuses to send a request with an image to a non-vision
provider, so the image cannot be silently dropped in transit - which is the
specific failure that started all of this.

**Minor**: the "score: X, need: Y" suggestion uses JS `toFixed(2)` where Python
uses `f"{x:.2f}"`. They agree except on values that are exact binary ties, where
Python rounds half-to-even (`0.125` -> `0.12`) and JS rounds half-up (`0.13`).
Display only; tested.

### VectorSimilarityMatcher (priority 6)

The filter that was dead in the Python for months. Both original bugs are fixed
and pinned by tests: an embedding failure is `skipped()` with a NaN score (never
a passing 1.0), and the score is raw cosine (never `(cos + 1) / 2`).

**Calibrated 2026-08-04, `Xenova/bge-m3` @ 1024 dims**, via
`cv-optimizer calibrate-vector ../cv.md ../applications`:

| set                              | cosine        |
| -------------------------------- | ------------- |
| 21 real job descriptions         | 0.794 – 0.898 |
| control: sourdough bread recipe  | 0.498         |
| control: wrong stack (Java role) | 0.542         |

Separation 0.252, so `THRESHOLD_VECTOR=0.67` (midpoint of the gap). Recorded in
`.env.example`; the code default stays `NaN` so an unmeasured threshold fails
loudly rather than passing everything.

**The local model is better than the hosted one it replaces**, on both measures
that matter:

| model                         | separation | spread among real jobs |
| ----------------------------- | ---------- | ---------------------- |
| gemini-embedding-001 (hosted) | 0.222      | 0.037                  |
| bge-m3 (local)                | **0.252**  | **0.104**              |

A ~3x wider spread among genuine jobs means it discriminates between them, not
just between "software" and "not software".

It still does not catch the one true domain mismatch: co.brick, the
computational-geometry role that TF-IDF correctly flags at 0.31, scores 0.867 -
mid-pack. Whole-document embedding averages that away. Chunked embedding remains
the upgrade if per-requirement signal is ever needed.

**Operational findings, both learned by hitting them:**

- **`onnxruntime-node` can only load once per process.** A second embedding
  worker in the same process dies with `ERR_DLOPEN_FAILED`. Concurrent jobs in
  one process must share a single `EmbeddingProvider`. See ADR 0002.
- **Cache location matters.** Transformers.js defaults to
  `node_modules/@huggingface/transformers/.cache`, which a `pnpm install`
  prunes. Now pinned to `.cache/models/` via `env.cacheDir`. Verified: a second
  `model:pull` takes 2.4s instead of 9 minutes.
- **Over-long input is refused, not truncated.** The tokenizer is loaded
  alongside the pipeline purely to check length first. Truncation would embed
  half a CV and return a confident number - exactly the failure mode this port
  exists to prevent.
- The download is ~2.2 GB because Transformers.js defaults to fp32 for this
  pipeline. A quantized `dtype` would cut that substantially with little effect
  on cosine, but the threshold is dtype-specific too, so switching means
  re-running `calibrate-vector`.

### AiGeneratedChecker (priority 7)

- The prompt is a copy of the Python prompt. It is identical, byte for byte.
  A test reads the Python file and compares SHA values.
- **The score is inverted.** The model reports `ai_probability`. The filter
  reports `1 - ai_probability`. A high score means the text looks human. This
  keeps the direction the same as the other filters.
- **`is_ai_generated` is dead.** The agent returns the flag. The Python filter
  then replaces `passed` with `score >= threshold` and ignores the flag. This
  port does the same.
  - The two rules do not agree. The prompt sets the flag above a probability of
    0.5. The threshold of 0.4 fails only above a probability of 0.6.
  - A probability of 0.55 therefore sets the flag and still passes. A test pins
    this. It is a quirk, not an improvement.
- **`noShame` divides the threshold by 2**, from 0.4 to 0.2. The Python does the
  same. Note the other lenient bounds are hard-coded, but this one is computed.
- The Python order for the text is `pdf_text`, then `html`, then structured
  data. This port has no structured data, so the last branch cannot occur.

## 8. Model split, and DeepSeek vision

hr-breaker uses two chat models. This port did not, at first. It does now.

| filter               | model    | hr-breaker equivalent |
| -------------------- | -------- | --------------------- |
| HallucinationChecker | `pro`    | `get_pro_model()`     |
| AiGeneratedChecker   | `flash`  | `get_flash_model()`   |
| VisionChecker        | `vision` | `get_flash_model()`   |

`VISION_MODEL` is new. It defaults to Gemini, not to `flash`.

**The DeepSeek API cannot accept an image. This is measured, not assumed.**

Tested against `api.deepseek.com` on 2026-08-04 with a real PNG:

| attempt                                       | result                                             |
| --------------------------------------------- | -------------------------------------------------- |
| `image_url` content part                      | 400 `unknown variant 'image_url', expected 'text'` |
| `image` content part                          | 400 same error                                     |
| `input_image` content part                    | 400 same error                                     |
| `/beta` endpoint                              | 400 same error                                     |
| model ids `deepseek-vl`, `vl2`, `v4-vision` … | 400 same error                                     |
| text only, same key                           | 200                                                |

The error does not change with the model id, even for ids that do not exist.
So the request schema itself has no image variant, and the rejection happens
before model dispatch. `/v1/models` lists only `deepseek-v4-flash` and
`deepseek-v4-pro`.

The DeepSeek **app** does show a vision mode. That is a first-party surface.
The public API has not followed. `@ai-sdk/deepseek` 3.0.21 is the current npm
release, so no client upgrade changes this.

Gemini works. Verified end to end through `providers/ai-sdk.ts`: a 64x64 blue
PNG, and the model answered `{"colour":"blue"}`.

**So hr-breaker's 0.00 scores have a simple cause.** Its `.env` sets
`FLASH_MODEL=deepseek/deepseek-v4-flash`, and `combined_reviewer` uses the
flash model. The image never reached the model. The reviewer judged the text
alone. That also explains why the result was unstable: a model guessing from
text order sometimes calls the layout good and sometimes does not. The earlier
idea, a race in `litellm_patch.py`, is the weaker explanation.

Also note: `deepseek-chat` answers, but it is not in `/v1/models`. Name a real
model.
