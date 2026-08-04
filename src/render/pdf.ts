/**
 * HTML -> PDF -> (text, PNG).
 *
 * The Python original used WeasyPrint; here Playwright's page.pdf() is the
 * natural fit and is already present elsewhere in this repo.
 *
 * The PNG matters: the vision filter grades the rendered page. When that image
 * fails to reach the model, the filter silently falls back to grading extracted
 * text and reports nonsense. Treat a missing PNG as a hard error, not a warning.
 */

export interface RenderOutput {
  readonly pdf: Uint8Array;
  readonly text: string;
  readonly pngPage1: Uint8Array;
  readonly pageCount: number;
  /** Extracted text per page, index 0 = page 1. */
  readonly pageTexts: readonly string[];
}

export interface Renderer {
  render(html: string): Promise<RenderOutput>;
  close(): Promise<void>;
}

export const notImplemented = (): Renderer => ({
  render: () => Promise.reject(new Error('Renderer not wired up yet')),
  close: () => Promise.resolve(),
});
