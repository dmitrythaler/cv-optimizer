/** Library entry point. The CLI is a thin wrapper over these. */

export { loadConfig } from './config.ts';
export type { Config } from './config.ts';
export { logger } from './logger.ts';
export { optimize } from './pipeline/orchestrator.ts';
export type { Generator } from './pipeline/orchestrator.ts';
export { register, all, skipped } from './filters/index.ts';
export type { Filter, FilterContext } from './filters/index.ts';
export { cosine } from './providers/embeddings.ts';
export type { EmbeddingProvider } from './providers/embeddings.ts';
export { localEmbeddings } from './providers/local-embeddings.ts';
export type { ChatProvider, ChatRequest } from './providers/llm.ts';
export type { Renderer, RenderOutput } from './render/pdf.ts';
export type * from './types.ts';
