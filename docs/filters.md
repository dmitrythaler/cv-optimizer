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
| 5   | AtsChecker       | LLM (text)         | 0.70                 | ATS screening against the posting     |
| 6   | VectorSimilarity | embeddings (local) | **must be measured** | semantic closeness to the JD          |
| 7   | AiGenerated      | LLM                | 0.40                 | does it read as machine-written       |
| 8   | LayoutChecker    | LLM (vision)       | binary               | is the rendered page BROKEN           |

Priority 2 is free.

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

**AtsChecker** — ATS screening from the extracted TEXT. A real applicant
tracking system parses text, so this one needs no image and runs on the cheap
model. The score is weighted: `overall_fit` 0.50, `keyword` 0.25, `experience`
0.175, `education` 0.075.

Passing needs the score at or above the threshold **and** `!disqualified`.
`disqualified` is a hard requirement the posting states and the CV does not meet
— a missing degree, a missing must-have language. A score above the threshold
can still fail on it, and that is correct, not a bug.

The score is **never zeroed out**. Whatever it computed is what it reports, so a
weak match is always distinguishable from a defect elsewhere.

**LayoutChecker** — the only filter that looks at the rendered page image, and
it asks one question: is this page BROKEN? Clipped text, overlap, garbled
glyphs, rendering artifacts. It does not grade taste, and it never sees the job.

Binary: score 1 or 0, threshold 1, like the two deterministic filters. A model
that claims `broken: true` while listing no defect is treated as not broken and
logged — this filter can veto a whole run, so it does not do so on an empty
assertion.

These two were one filter, and splitting them removed a real trap. See
`design-notes.md` §2 for the measurements that forced it.

**VectorSimilarity** — embedding cosine, from a local model in a worker thread.
Coarse: it separates a software job from a bread recipe but barely distinguishes
two engineering roles. Raw cosine, never rescaled.

Its threshold has **no default** — `THRESHOLD_VECTOR` resolves to `NaN`, so every
comparison is false and the filter cannot silently pass. An inherited value of
`0.55` was measured against hosted `gemini-embedding-001` at 768 dimensions and
does not transfer to a different model. Measure your own: embed a corpus of real
postings, one `jd.txt` per folder, against your CV, add an off-topic control,
and put the threshold between the two clusters. `calibrate-vector <cv> <dir>`
does the work. Record the numbers in `design-notes.md`.

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
