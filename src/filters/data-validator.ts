import type { Filter, FilterContext } from './base.ts';
import type { FilterResult } from '../types.ts';

const NAME = 'DataValidator';
const THRESHOLD = 1.0;

/**
 * The pandoc fences the stylesheet needs. A missing fence does NOT make pandoc
 * fail: it renders the text unstyled, so the CV silently comes out in a default
 * face with no layout. That is why these are checked as data, not trusted.
 */
const HAS_NAME = /\[[^\]]+\]\{\.cv-name\}/;
const HAS_CONTACTS = /^:::\s*\{?\.contacts\}?\s*$/m;
const HAS_SUMMARY = /^:::\s*\{?\.summary\}?\s*$/m;
const HAS_SECTION = /^##\s+\S/m;
const HAS_HTML_TAG = /<(script|html|head|body|div|section|header)\b/i;

/** Opening fences carry a class; a bare ":::" closes one. */
const countFences = (md: string): { open: number; close: number } => {
  let open = 0;
  let close = 0;
  for (const line of md.split('\n')) {
    const t = line.trim();
    if (!t.startsWith(':::')) continue;
    if (/^:::+\s*$/.test(t)) close++;
    else open++;
  }
  return { open, close };
};

/**
 * Structural checks on the generated pandoc markdown.
 *
 * Replaced the HTML checks on 2026-09-03, when the renderer became
 * pandoc + WeasyPrint. The old rules looked for <header class="header"> and
 * friends, which no longer exist in the output at all - left in place they
 * would have failed every CV.
 */
export const validateMarkdown = (markdown: string): string[] => {
  const issues: string[] = [];

  if (!HAS_NAME.test(markdown)) {
    issues.push('Missing the name span, [Name]{.cv-name}');
  }
  if (!HAS_CONTACTS.test(markdown)) {
    issues.push('Missing the ::: {.contacts} block');
  }
  if (!HAS_SUMMARY.test(markdown)) {
    issues.push('Missing the ::: {.summary} block');
  }
  if (!HAS_SECTION.test(markdown)) {
    issues.push('Resume has no content sections (no "## " heading)');
  }

  const { open, close } = countFences(markdown);
  if (open !== close) {
    issues.push(
      `Unbalanced pandoc fences: ${open} opened, ${close} closed. ` +
        'An unclosed fence renders unstyled instead of failing.',
    );
  }

  const tag = HAS_HTML_TAG.exec(markdown);
  if (tag) {
    issues.push(`Raw HTML tag <${tag[1]}> is not allowed; the output is markdown`);
  }

  return issues;
};

export const dataValidator: Filter = {
  name: NAME,
  priority: 1,

  evaluate: ({ resume }: FilterContext): Promise<FilterResult> => {
    const issues = validateMarkdown(resume.markdown);
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
