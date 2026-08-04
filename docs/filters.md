# Filters

A filter grades one candidate CV and returns a `FilterResult`. Lower `priority`
runs first, so cheap deterministic checks come before paid model calls.

## Roster

Ported from the Python original. Thresholds are the calibrated values, not the
originals — see `porting-notes.md` for what was wrong with those.

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
`LLMChecker` in hr-breaker; renamed here because the old name described the
implementation rather than the job. The old name still appears in historical
`cv_failed_filters` entries in `../results.json`.

Passing requires **all three**: `looks_professional` AND `atsScore >= threshold`
AND `!disqualified`.

The reported score is the weighted ATS score — `overall_fit` 0.50, `keyword`
0.25, `experience` 0.175, `education` 0.075 — but **only when
`looks_professional` is true**. Otherwise it is hard-coded to `0.0`. So a
`0.00` never means "the ATS rejected you"; it means the visual half said no and
the ATS numbers were discarded. See `porting-notes.md` for how that turned a
plumbing fault into weeks of apparently-bad CVs.

**VectorSimilarity** — embedding cosine, from a local model in a worker thread.
Coarse: it separates a software job from a bread recipe but barely distinguishes
two engineering roles. Raw cosine, never rescaled.

Its threshold has **no default** — `THRESHOLD_VECTOR` resolves to `NaN`, so every
comparison is false and the filter cannot silently pass. The Python value of
`0.55` was measured against hosted `gemini-embedding-001` at 768 dimensions and
does not transfer to a different model. Measure your own: embed the real corpus
under `../applications/*/jd.txt` against `../cv.md`, add an off-topic control,
and put the threshold between the two clusters. Record the numbers in
`porting-notes.md`.

**AiGenerated** — heuristic LLM judgement on whether the prose reads as
machine-written.

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
