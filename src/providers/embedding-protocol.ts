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

export type WorkerRequest = EmbedRequest | DimsRequest;

/** A request before the host assigns it a correlation id. */
export type UnsentRequest =
  | { readonly type: 'embed'; readonly texts: readonly string[] }
  | { readonly type: 'dims' };

export interface WorkerOk {
  readonly id: number;
  readonly ok: true;
  /** Vectors for 'embed', or a single-element [dimensions] for 'dims'. */
  readonly data: number[][] | number;
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
