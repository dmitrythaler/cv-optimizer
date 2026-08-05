# Filters

A filter grades one candidate CV and returns a `FilterResult`. Lower `priority`
runs first, so cheap deterministic checks come before paid model calls.

## Roster

Thresholds are calibrated values, measured against real data — see
`design-notes.md` for how, and why round numbers are not used.

| Pri | Filter           | Kind               | Threshold            | Purpose                               |
| --- | ---------------- | ------------------ | -------------------- | ------------------------------------- |
| 0   | ContentLength    | deterministic      | 1.0                  | does the content fit the page budget  |
| 1   | DataValidator    | deterministic      | 1.0                  | HTML structure is sane                |
| 3   | Hallucination    | LLM                | 0.90                 | claims not supported by the source CV |
| 4   | KeywordMatcher   | TF-IDF             | 0.25                 | literal term overlap with the JD      |
| 5   | VisionChecker    | LLM (vision) + ATS | 0.70                 | visual quality AND ATS screening      |
| 6   | VectorSimilarity | embeddings (local) | **must be measured** | semantic closeness to the JD          |
| 7   | AiGenerated      | LLM                | 0.40                 | does it read as machine-written       |

Priorities 2 and 8 are free — the original used 8 for a translation-quality
check that only ran on cross-language output.

## What each is actually measuring

**ContentLength / DataValidator** — pure computation, no model, no network.
These pinned at 1.00 in every historical run, which is expected: they either
pass or they don't.

**Hallucination** — the one that protects you. The optimizer will invent domain
experience to score better on keywords; this catches it. A _falling_
hallucination score across iterations means fabrication is creeping in.

**KeywordMatcher** — TF-IDF cosine between CV and JD. Deterministic and free.
Rough read: `0.50+` strong match, `~0.30` either a thin JD or a real domain gap,
below `0.30` on a detailed JD means genuine mismatch. Historically the most
trustworthy number in the set.

**VisionChecker** — one model call doing two jobs: a visual quality check on the
rendered page image, and an ATS screening on the extracted text. Named
Named for what it does, because an earlier name described the
implementation rather than the job. The old name still appears in historical
`cv_failed_filters` entries in `../results.json`.

Passing requires **all three**: `looks_professional` AND `atsScore >= threshold`
AND `!disqualified`.

The reported score is the weighted ATS score — `overall_fit` 0.50, `keyword`
0.25, `experience` 0.175, `education` 0.075 — but **only when
`looks_professional` is true**. Otherwise it is hard-coded to `0.0`. So a
`0.00` never means "the ATS rejected you"; it means the visual half said no and
the ATS numbers were discarded. See `design-notes.md` for how that turns a
plumbing fault into weeks of apparently-bad CVs.

**VectorSimilarity** — embedding cosine, from a local model in a worker thread.
Coarse: it separates a software job from a bread recipe but barely distinguishes
two engineering roles. Raw cosine, never rescaled.

Its threshold has **no default** — `THRESHOLD_VECTOR` resolves to `NaN`, so every
comparison is false and the filter cannot silently pass. An inherited value of
`0.55` was measured against hosted `gemini-embedding-001` at 768 dimensions and
does not transfer to a different model. Measure your own: embed the real corpus
under `../applications/*/jd.txt` against `../cv.md`, add an off-topic control,
and put the threshold between the two clusters. Record the numbers in
`design-notes.md`.

**AiGenerated** — an LLM judges if a machine wrote the text.

The score is **inverted**. The model reports `ai_probability`. The filter
reports `1 - ai_probability`. A high score means the text looks human. This
keeps the direction the same as every other filter: high is good.

The prompt is careful about false positives. A CV is formulaic on purpose.
Action verbs, equal bullet lengths and metrics are good practice, not tells.
The prompt flags only impossible claims, internal contradictions, empty
buzzwords and repeated filler.

`noShame` divides the threshold by 2.

## Adding a filter

Implement `Filter` from `filters/base.ts`, then `register()` it.

```
name       stable identifier, appears in logs and results.json
priority   lower runs first
evaluate   (ctx) => Promise<FilterResult>
```

Requirements:

- If the filter cannot run — network down, missing credential, absent input —
  return `skipped(name, threshold, reason)` and log at WARN. **Never** return a
  passing score to cover an error.
- Put the real number in `score` even when it fails. Diagnostics depend on it.
- Populate `issues` and `suggestions`; they are fed back to the generator
  verbatim as the next iteration's instructions.
- Thresholds belong in `config.ts`, driven by env, calibrated against measured
  data, with the measurement written down.
