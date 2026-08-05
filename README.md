# cv-optimizer

Tailors a CV to a job description, then grades its own output until it passes.

Give it a job URL and a CV. It fetches the posting, strips the page furniture,
rewrites the CV against it, renders a PDF, and puts that PDF through seven
filters — length, structure, fabrication, keyword match, a vision check on the
rendered page, semantic similarity, and a "does this read like a machine wrote
it" check. If a filter fails, the complaints go back to the generator and it
tries again.

Every run writes one folder holding the posting, the CV, every iteration, and a
full record of what each filter scored.

> Based on **hr-breaker**, an earlier Python tool. This is a reimplementation,
> not a wrapper.

## Requirements

- Node >= 24 (runs TypeScript sources directly through native type stripping)
- pnpm
- poppler-utils on PATH (`pdftotext`, `pdftoppm`)

## Install

```bash
pnpm install
pnpm model:pull   # download the local embedding model before the first run
```

`model:pull` fetches and caches the model named by `EMBEDDING_MODEL`. Do it up
front — it is a large download, and paying for it inside the first optimize run
looks like a hang.

Copy `.env.example` to `.env` and fill in the API keys. Embeddings run locally
and need no key.

## Use

```bash
# the whole thing, straight from a job URL
pnpm start -- optimize ../cv.md https://example.com/jobs/12345

# or from a saved posting
pnpm start -- optimize ../cv.md path/to/jd.txt

# fetch and clean a posting into its own run folder, nothing else
pnpm start -- fetch-job https://example.com/jobs/12345

# score one CV against one job with chosen filters (diagnostic)
pnpm start -- check-filters ../cv.md path/to/jd.txt KeywordMatcher,VectorSimilarityMatcher

# measure THRESHOLD_VECTOR for the configured embedding model
pnpm start -- calibrate-vector ../cv.md ../applications

pnpm start -- --help
```

### Output

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

The folder name is fixed. The CV file name inside is yours, through
`CV_NAME_TEMPLATE` — that is the name a recruiter sees once the file leaves the
folder.

**A produced PDF is not a pass.** The exit code and `optimization.json` carry
the verdict; a failing run still writes its best attempt so you can look at it.

## Develop

```bash
pnpm test        # node --test
pnpm typecheck   # tsc --noEmit
pnpm build       # tsc -> dist/
pnpm fmt         # oxfmt
```

Source is run directly by Node, so relative imports carry a `.ts` extension.
`tsc` rewrites them to `.js` on emit. This is intentional.

## Docs

- [Design notes](docs/design-notes.md) — why the thresholds, guards and prompts
  are what they are. **Read this before touching a filter.**
- [Architecture](docs/architecture.md) — how the pieces fit
- [Filters](docs/filters.md) — the roster, thresholds, and how to add one
- [ADRs](docs/adr/) — decisions and why

## License

MIT
