/**
 * Filter roster. Importing this module registers every implemented filter.
 * See docs/filters.md for the full planned set and thresholds.
 */
import { register } from './registry.ts';
import { contentLength } from './content-length.ts';
import { dataValidator } from './data-validator.ts';

register(contentLength);
register(dataValidator);

export { register, all } from './registry.ts';
export { skipped } from './base.ts';
export { contentLength } from './content-length.ts';
export { dataValidator, validateHtml } from './data-validator.ts';
export type { Filter, FilterContext } from './base.ts';
