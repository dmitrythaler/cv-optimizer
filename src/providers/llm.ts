import type { z } from 'zod';

/**
 * Chat/vision model access.
 *
 * Intentionally a thin seam: the pipeline talks to this interface, never to a
 * vendor SDK directly. Swapping the Vercel AI SDK for something else should be
 * a change to `ai-sdk.ts` only.
 */

export interface ChatRequest {
  readonly system?: string;
  readonly prompt: string;
  /** PNG bytes for vision-capable calls. */
  readonly image?: Uint8Array;
}

export interface ChatProvider {
  readonly model: string;
  complete(req: ChatRequest): Promise<string>;
  /**
   * Structured output, validated against `schema`.
   *
   * Rejects if the model cannot produce conforming output. Do NOT swallow that
   * and substitute a default - a filter that cannot reach a verdict must report
   * itself skipped, not invent one.
   */
  object<T>(req: ChatRequest, schema: z.ZodType<T>): Promise<T>;
  /** True when the provider can actually accept `image`. Check before relying on it. */
  supportsVision(): boolean;
}

export const notImplemented = (model: string): ChatProvider => ({
  model,
  complete: () => Promise.reject(new Error('ChatProvider not wired up yet')),
  object: () => Promise.reject(new Error('ChatProvider not wired up yet')),
  supportsVision: () => false,
});
