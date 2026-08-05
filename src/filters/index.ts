/**
 * Filter roster. Importing this module registers every implemented filter.
 * See docs/filters.md for the full planned set and thresholds.
 */
import { register } from './registry.ts';
import { contentLength } from './content-length.ts';
import { dataValidator } from './data-validator.ts';
import { hallucination } from './hallucination.ts';
import { keywordMatcher } from './keyword-matcher.ts';
import { atsChecker } from './ats-checker.ts';
import { vectorSimilarity } from './vector-similarity.ts';
import { aiGenerated } from './ai-generated.ts';
import { layoutChecker } from './layout-checker.ts';

register(contentLength);
register(dataValidator);
register(hallucination);
register(keywordMatcher);
register(atsChecker);
register(vectorSimilarity);
register(aiGenerated);
register(layoutChecker);

export { register, all, runAll } from './registry.ts';
export { skipped } from './base.ts';
export { contentLength } from './content-length.ts';
export { dataValidator, validateHtml } from './data-validator.ts';
export { hallucination, hallucinationResult } from './hallucination.ts';
export { keywordMatcher, checkKeywords } from './keyword-matcher.ts';
export { atsChecker, atsResult, computeAtsScore, SCORE_WEIGHTS } from './ats-checker.ts';
export { vectorSimilarity } from './vector-similarity.ts';
export { aiGenerated, aiGeneratedResult } from './ai-generated.ts';
export { layoutChecker, layoutResult } from './layout-checker.ts';
export type { Filter, FilterContext } from './base.ts';
