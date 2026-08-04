/** Message protocol between the host and the embedding worker. Shared by both sides. */

export interface EmbedRequest {
  readonly id: number;
  readonly type: 'embed';
  readonly texts: readonly string[];
}

export interface DimsRequest {
  readonly id: number;
  readonly type: 'dims';
}

/**
 * Load the model without embedding anything, so the download happens as an
 * explicit step rather than stalling the first optimize run.
 */
export interface PrefetchRequest {
  readonly id: number;
  readonly type: 'prefetch';
}

export type WorkerRequest = EmbedRequest | DimsRequest | PrefetchRequest;

/** A request before the host assigns it a correlation id. */
export type UnsentRequest =
  | { readonly type: 'embed'; readonly texts: readonly string[] }
  | { readonly type: 'dims' }
  | { readonly type: 'prefetch' };

export interface WorkerOk {
  readonly id: number;
  readonly ok: true;
  /** Vectors for 'embed', the dimension count for 'dims', null for 'prefetch'. */
  readonly data: number[][] | number | null;
}

export interface WorkerErr {
  readonly id: number;
  readonly ok: false;
  readonly error: string;
}

export type WorkerResponse = WorkerOk | WorkerErr;

export interface WorkerInit {
  readonly model: string;
  /** 0 = model default. */
  readonly dimensions: number;
  readonly maxInputTokens: number;
}
