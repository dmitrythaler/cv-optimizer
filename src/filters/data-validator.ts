import type { Filter, FilterContext } from './base.ts';
import type { FilterResult } from '../types.ts';

const NAME = 'DataValidator';
const THRESHOLD = 1.0;

const HAS_HEADER = /<header[^>]*class="header"/;
const HAS_NAME = /<h1[^>]*class="name"[^>]*>/;
const HAS_SECTION = /<section[^>]*class="section"/;
const HAS_SCRIPT = /<script/i;

/**
 * Structural checks on the generated HTML.
 *
 * Rules
 * and message strings are identical, including the else-if: when the header is
 * missing entirely the name is NOT separately reported.
 *
 * NOT ported: the `validate_resume_data()` branch, which validates a structured
 * ResumeData object (contact fields, experience/education entries). This build
 * has no structured-resume mode - `OptimizedResume` carries HTML only - so
 * there is nothing for it to check. See docs/design-notes.md.
 */
export const validateHtml = (html: string): string[] => {
  const issues: string[] = [];

  if (!HAS_HEADER.test(html)) {
    issues.push("Missing header element with class='header'");
  } else if (!HAS_NAME.test(html)) {
    issues.push("Missing name (h1 with class='name') in header");
  }

  if (!HAS_SECTION.test(html)) {
    issues.push('Resume has no content sections');
  }

  if (HAS_SCRIPT.test(html)) {
    issues.push('Script tags are not allowed');
  }

  return issues;
};

export const dataValidator: Filter = {
  name: NAME,
  priority: 1,

  evaluate: ({ resume }: FilterContext): Promise<FilterResult> => {
    const issues = validateHtml(resume.html);
    const score = issues.length === 0 ? 1.0 : 0.0;

    return Promise.resolve({
      filterName: NAME,
      passed: score >= THRESHOLD,
      score,
      threshold: THRESHOLD,
      issues,
      suggestions: issues.length > 0 ? ['Fix missing required fields/elements in resume'] : [],
    });
  },
};
