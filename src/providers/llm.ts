/**
 * Chat/vision model access.
 *
 * Intentionally a thin seam: the pipeline talks to this interface, never to a
 * vendor SDK directly. Swapping the Vercel AI SDK for something else should be
 * a change to this file only.
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
  /** True when the provider can actually accept `image`. Check before relying on it. */
  supportsVision(): boolean;
}

export const notImplemented = (model: string): ChatProvider => ({
  model,
  complete: () => Promise.reject(new Error('ChatProvider not wired up yet')),
  supportsVision: () => false,
});
