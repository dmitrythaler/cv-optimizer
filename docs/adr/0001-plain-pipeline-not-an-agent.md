# 1. The optimizer is a plain pipeline, not an agent

Date: 2026-08-03

## Status

Accepted

## Context

The parent repo already runs an agent harness for the job-scanning side —
navigating boards, reading postings, judging eligibility, filling forms. That
work is genuinely open-ended: the next action depends on what the previous one
found.

It is tempting to reach for the same tool here, since both involve LLMs.

## Decision

CV optimization is implemented as a deterministic pipeline. No agent, no tool
selection, no model in the control flow. Models do the _work_ (generate, judge);
plain code decides _what happens next_.

## Rationale

The steps are fixed and known in advance: generate, render, grade, decide,
maybe repeat. There is no branch for a model to choose. Adding an agent layer
would buy nothing and cost three things worth keeping:

- **Determinism** — the same inputs produce the same behaviour, which is what
  makes a threshold regression detectable at all.
- **Cheap parallelism** — N jobs is N processes from a shell script. An agent
  version ran 8 concurrently from an 18-line runner.
- **Debuggability** — when a filter reported nonsense for two months, it was
  found by reading one file. Buried under agent reasoning about which tool to
  call, that failure is much harder to see.

## Consequences

- The pipeline stays boring and testable, which is the point.
- Anything genuinely open-ended belongs on the job-scanning side of the repo,
  not here.
- If a future step really does need runtime judgement, it goes behind a seam as
  a `Generator` or provider implementation — the loop itself stays plain.
