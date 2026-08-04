# Architecture

## Shape

A batch pipeline, not an agent. The steps are fixed and there is nothing to
decide at runtime, so there is no model in the control flow — only in the work.

```
cv.md + jd.txt
      |
      v
   parse  ------------------------------> JobPosting, ResumeSource
      |
      v
 +--> generate ---> OptimizedResume (HTML)
 |       |
 |       v
 |    render ------> PDF + extracted text + page-1 PNG
 |       |
 |       v
 |    run filters (concurrent) ---------> FilterResult[]
 |       |
 |    all passed? --- yes ---> file it, done
 |       |
 |       no
 |       |
 +-- feed failures back as feedback  (up to maxIterations)
```

Out of iterations means the best attempt is returned with `passed: false`.
Callers must check `outcome.passed` — a PDF exists either way.

## Seams

Four interfaces isolate everything external. Each has a `notImplemented()`
placeholder so the shape is exercised before the dependency lands.

| Seam                | File                       | Responsibility                                      |
| ------------------- | -------------------------- | --------------------------------------------------- |
| `Generator`         | `pipeline/orchestrator.ts` | produce candidate HTML from source + job + feedback |
| `ChatProvider`      | `providers/llm.ts`         | chat and vision model calls (remote)                |
| `EmbeddingProvider` | `providers/embeddings.ts`  | text -> vectors (local)                             |
| `Renderer`          | `render/pdf.ts`            | HTML -> PDF, text, PNG                              |

Chat and embeddings are separate because they are different in kind, not just in
vendor: chat is a remote API call, embedding is local inference. See ADR 0002.

## Concurrency

One worker thread, for embeddings only.

```
main thread                          worker thread
-----------                          -------------
parse, generate (HTTP)
render (Playwright, own process)
grade filters ---- embed() ------>   ONNX inference
                <--- vectors -----
```

Embedding is the only CPU-bound step; left inline it would block the event loop
while the rest of the pipeline waits on chat API calls. Everything else is
I/O-bound and belongs on the main thread — a concurrency-limited `Promise.all`
covers running several jobs at once. No child processes.

## Why the seams matter

The Python version reached a vendor SDK from inside a filter, which is how a
missing API key became an invisible always-passing filter. Here, a filter
receives a provider and cannot construct one, so an unconfigured provider fails
loudly at startup instead of quietly at grading time.

## Data flow rules

- **The source CV is never mutated.** Every run generates a fresh document.
- **Filters grade the rendered artifact**, not the HTML. What the ATS parses out
  of the PDF is what matters, and it differs from what the HTML implies.
- **`score` is diagnostic, `passed` is the decision.** Nothing aggregates scores.

## Planned dependencies

Nothing beyond `typescript`, `@types/node` and `oxfmt` is installed yet. Expected
additions, in the order they will be needed:

| Need                     | Candidate                                                |
| ------------------------ | -------------------------------------------------------- |
| chat + structured output | Vercel AI SDK + Zod                                      |
| HTML -> PDF/PNG          | Playwright (already used elsewhere in this repo)         |
| TF-IDF                   | hand-rolled, or `natural`                                |
| local embeddings         | `@huggingface/transformers` (ONNX), loaded in the worker |

Each arrives with the filter that needs it, not before.
