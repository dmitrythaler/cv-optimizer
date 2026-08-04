# cv-optimizer

Tailors a CV to a job description, then grades its own output until it passes.

TypeScript re-implementation of [`../hr-breaker`](../hr-breaker).

> **Status: backbone only.** Structure, types and CLI shell are in place. The
> generator, filters, providers and renderer are stubs. No model is called yet.

## Requirements

- Node >= 24 (current Active LTS; runs TypeScript sources directly via native type stripping)
- pnpm

## Install

```bash
pnpm install
pnpm model:pull   # download the local embedding model before the first run
```

`model:pull` fetches and caches the model named by `EMBEDDING_MODEL`. Do this
up front - it is a large download, and paying for it inside the first optimize
run looks like a hang.

## Use

```bash
# parse inputs, call nothing
pnpm start -- optimize ../cv.md ../applications/<job>/jd.txt --dry-run

# list registered filters
pnpm start -- filters

pnpm start -- --help
```

## Develop

```bash
pnpm test        # node --test
pnpm typecheck   # tsc --noEmit
pnpm build       # tsc -> dist/
pnpm fmt         # oxfmt
```

Source is run directly by Node, so relative imports carry a `.ts` extension.
`tsc` rewrites them to `.js` on emit. This is intentional.

## Configuration

Copy `.env.example` to `.env`. Everything is env-driven; thresholds are
calibrated against measured data rather than chosen by feel — the measurements
are in [`docs/porting-notes.md`](docs/porting-notes.md).

## Docs

- [Architecture](docs/architecture.md) — how the pieces fit
- [Filters](docs/filters.md) — the roster, thresholds, and how to add one
- [Porting notes](docs/porting-notes.md) — what the Python original got wrong.
  Read this before touching a filter.
- [ADRs](docs/adr/) — decisions and why

## License

MIT
