/** Core domain types. Deliberately provider-agnostic. */

/** The raw CV, as authored by the human. Never mutated by the pipeline. */
export interface ResumeSource {
  readonly text: string;
  readonly path: string;
  /**
   * Extra instructions from `-i`. These count as source of truth alongside the
   * CV itself: HallucinationChecker is shown them so that details supplied on
   * the command line are not reported as fabrications.
   */
  readonly instructions: string | null;
}

/** A parsed job posting. */
export interface JobPosting {
  readonly title: string;
  readonly company: string;
  /**
   * The parser's BRIEF SUMMARY of the role, not the whole posting.
   * KeywordMatcher and VectorSimilarityMatcher score against
   * title + description + requirements, so this is deliberately condensed.
   */
  readonly description: string;
  /** The full posting text. AtsChecker falls back to it when description is empty. */
  readonly rawText: string;
  readonly requirements: readonly string[];
  /**
   * Explicit keywords extracted by the job parser. Added to the significant set
   * regardless of TF-IDF weight; ones absent from the vocabulary are weighted
   * at 0.1.
   */
  readonly keywords: readonly string[];
  /** BCP-47-ish language code detected from the posting, e.g. "en", "pl". */
  readonly language: string;
}

/** One generated candidate CV, before or after rendering. */
export interface OptimizedResume {
  readonly markdown: string;
  /** Text extracted back out of the rendered PDF. Filters grade this, not the HTML. */
  readonly pdfText: string | null;
  /** PNG of the rendered first page, for vision-based filters. */
  readonly pngPage1: Uint8Array | null;
  /** Rendered page count. null when not yet rendered. */
  readonly pageCount: number | null;
  /**
   * Extracted text per page. ContentLength needs page 2 in isolation to detect
   * overflow, which whole-document `pdfText` cannot express.
   */
  readonly pageTexts: readonly string[] | null;
}

/** Verdict from a single filter. */
export interface FilterResult {
  readonly filterName: string;
  readonly passed: boolean;
  /** Raw score in the filter's own units. Display and diagnostics only. */
  readonly score: number;
  readonly threshold: number;
  readonly issues: readonly string[];
  readonly suggestions: readonly string[];
}

/** One trip around the generate/grade loop. */
export interface Iteration {
  readonly n: number;
  readonly resume: OptimizedResume;
  readonly results: readonly FilterResult[];
  readonly passed: boolean;
}

export interface OptimizationOutcome {
  readonly iterations: readonly Iteration[];
  /** The iteration actually filed. Not always the last one. */
  readonly filed: Iteration;
  readonly passed: boolean;
  readonly failedFilters: readonly string[];
}
