/**
 * Filter roster. Importing this module registers every implemented filter.
 * See docs/filters.md for the full planned set and thresholds.
 */
import { register } from './registry.ts';
import { contentLength } from './content-length.ts';
import { dataValidator } from './data-validator.ts';
import { hallucination } from './hallucination.ts';
import { keywordMatcher } from './keyword-matcher.ts';
import { visionChecker } from './vision-checker.ts';
import { vectorSimilarity } from './vector-similarity.ts';
import { aiGenerated } from './ai-generated.ts';

register(contentLength);
register(dataValidator);
register(hallucination);
register(keywordMatcher);
register(visionChecker);
register(vectorSimilarity);
register(aiGenerated);

export { register, all } from './registry.ts';
export { skipped } from './base.ts';
export { contentLength } from './content-length.ts';
export { dataValidator, validateHtml } from './data-validator.ts';
export { hallucination, hallucinationResult } from './hallucination.ts';
export { keywordMatcher, checkKeywords } from './keyword-matcher.ts';
export { visionChecker, visionResult, computeAtsScore, SCORE_WEIGHTS } from './vision-checker.ts';
export { vectorSimilarity } from './vector-similarity.ts';
export { aiGenerated, aiGeneratedResult } from './ai-generated.ts';
export type { Filter, FilterContext } from './base.ts';
