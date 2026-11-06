# cv-optimizer

Tailors a CV to a job description, then grades its own output until it passes.

Give it a job URL or MD file and a CV(text/md). It fetches the posting, strips the page furniture,
rewrites the CV against it, renders a PDF, and puts that PDF through eight
filters — length, structure, fabrication, keyword match, ATS screening,
semantic similarity, a "does this read like a machine wrote it" check, and a
vision check on the rendered page. If a filter fails, the complaints go back to
the generator and it tries again.

Every run writes one folder holding the posting, the CV, every iteration, and a
full record of what each filter scored.

It runs standalone — `example.cv.md` is committed, so a fresh clone works. It is
also one stage of a larger AI job-crawling pipeline, which is where nearly all
its mileage comes from: there a crawler judges a posting, fetches it, translates
it and writes `jd.txt` into a folder per job, and this tool is run against that
file.

**Feed it a text JD, not a URL.** Both work, but a saved posting gives better
results every time. Page cleaning is the weakest step in the chain: schema.org
JSON-LD is read when a board publishes it, and when none is there the fallback
is word lists that only cover the languages somebody added, so a German or
Polish page keeps much of its navigation and legal boilerplate. That junk
reaches the keyword and similarity filters as if it were the job. Text that is
already extracted, and already in English, skips the whole problem.

> Based on [**hr-breaker**](https://github.com/btseytlin/hr-breaker), an
> earlier Python tool. This is a reimplementation in TypeScript, not a wrapper:
> no code is shared, and the filter roster, the thresholds, the renderer and the
> output layout all differ. The idea — generate a CV, grade it yourself, feed
> the complaints back — is theirs.

## Requirements

- Node >= 24 (runs TypeScript sources directly through native type stripping)
- pnpm
- **pandoc** on PATH — turns the generated markdown into HTML
- **WeasyPrint** on PATH — turns that HTML into the PDF
- **poppler-utils** on PATH (`pdftotext`, `pdftoppm`) — reads the PDF back

The renderer checks all four binaries when it starts and refuses to run without
them. A missing one fails at once, not half way through a paid job.

```bash
# Debian / Ubuntu
sudo apt install pandoc weasyprint poppler-utils
# Arch
sudo pacman -S pandoc-cli weasyprint poppler
# macOS
brew install pandoc weasyprint poppler
```

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

## Configuration

Everything is configured through `.env`, and `.env.example` documents every
setting with the measurement behind it. There is no config file and no flags
for these — the environment is the single source.

Four groups matter.

**The models.** Three roles, not three vendors. `PRO_MODEL` is the careful one
and grades fabrication; `FLASH_MODEL` is the cheap one and does the ATS
screening and the machine-writing check; `VISION_MODEL` must accept images and
is used by one filter only. Prefix a name with `ollama/` to run it locally and
free. `VISION_MODEL` has no local option, so leave it unset and that one filter
skips — and says it skipped, which is not the same as passing.

**The embedding model.** `EMBEDDING_MODEL` runs locally through ONNX in a worker
thread. No key, no network at run time, one large download the first time.

**The thresholds.** `THRESHOLD_*` decides pass or fail per filter.
`THRESHOLD_VECTOR` is the one to respect: it is specific to the embedding model
and has no default, so an unmeasured value fails loudly instead of passing
everything. Change `EMBEDDING_MODEL` and you must re-run `calibrate-vector` and
write the new number down. The others are calibrated against measured data, and
`docs/design-notes.md` records each measurement — read that before moving one.

**The output name.** `CV_NAME_TEMPLATE` names the CV file inside the run folder,
because that is the name a recruiter sees once the file leaves the folder. It
takes `{date}`, `{time}`, `{company}`, `{position}` and `{lang}`. An unknown
placeholder stops the run at startup; it never ships as literal text in a file
name.

Two more worth knowing: `MAX_ITERATIONS` caps the retry loop, and
`NO_SHAME=true` relaxes the fabrication rules. The second one exists to be
measured against, not used.

## Use

`example.cv.md` is a committed example CV — invented companies, real stack — in
the pandoc markdown this tool expects. Copy it, put your own history in it, and
keep the shape.

```bash
# from a saved posting. THE PREFERRED ROUTE - see the note at the top
pnpm start -- optimize example.cv.md path/to/jd.txt

# straight from a job URL. It fetches and cleans the page itself, which is the
# one step that can quietly hand a filter a page of navigation instead of a job
pnpm start -- optimize example.cv.md https://example.com/jobs/12345

# fetch and clean a posting into its own run folder, nothing else
pnpm start -- fetch-job https://example.com/jobs/12345

# score one CV against one job with chosen filters (diagnostic)
pnpm start -- check-filters example.cv.md path/to/jd.txt KeywordMatcher,VectorSimilarityMatcher

# measure THRESHOLD_VECTOR for the configured embedding model
pnpm start -- calibrate-vector example.cv.md other-path/to/applications

pnpm start -- --help
```

### Output

One run writes one folder:

```
output/20260805-0912-some_company-full_stack_engineer/
  jd.txt                the posting, fetched and cleaned
  John.Dow.CV.some_company.full_stack_engineer.pdf   <- CV_NAME_TEMPLATE
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

[WTFPL](LICENSE), version 2. Do what the fuck you want to.
