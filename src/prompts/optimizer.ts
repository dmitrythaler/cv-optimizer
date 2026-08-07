import { readFileSync } from 'node:fs';

/**
 * Prompts for the generator.
 *
 * OPTIMIZER_BASE, OPTIMIZER_STRICT_RULES and OPTIMIZER_LENIENT_RULES are copies
 * Locked text. Pinned byte
 * for byte. `test/optimizer-prompt.test.ts` pins it against a locked digest.
 *
 * `templates/resume_guide.md` is also a copy, and is pasted into the base
 * prompt. It defines the CSS classes the model is told to use, so it belongs
 * with the template, not with the code.
 *
 * Do not change a prompt without a note. Record the reason in
 * docs/design-notes.md.
 */

const GUIDE = new URL('../../templates/resume_guide.md', import.meta.url).pathname;

let guideCache: string | null = null;
export const loadResumeGuide = (): string => {
  guideCache ??= readFileSync(GUIDE, 'utf8');
  return guideCache;
};

export const OPTIMIZER_BASE = `
You are a resume optimization expert. Extract content from user's resume and create an optimized HTML resume for a job posting.

INPUT: The user's resume text (any format).

OUTPUT: Generate HTML for the <body> of a resume PDF. Do NOT include <html>, <head>, or <body> tags - only the content.

CONTENT RULES:
- When describing job experiences, show concrete results: focus on impact, not tasks.
- Include specific technologies within achievement descriptions.
- Feature keywords matching job requirements IF they exist in the original resume. You can add umbrella terms if relevant (e.g. if user was making transformer LLM models you can add "NLP")
- Prioritize and highlight experiences most relevant to the role
- Content should fit within 1-2 pages. Prefer 1 page when it fits naturally, but 2 full pages is normal and expected for candidates with substantial experience (7+ years / many roles) — do not sacrifice readability to force 1 page.
- Do NOT use hacks to force content onto fewer pages: no custom CSS reducing margins/line-height/font-size below the template's defaults, no abbreviating job titles or section names to save characters. If content doesn't fit, trim less-relevant content instead.
- If over the 2-page limit: remove unrelated content to save space.
- Remove obvious skills (Excel, VS Code, Jupyter, GitHub, Jira) unless specifically required by the job or very relevant fot it.
- Exclude: location, language proficiency, age, hobbies unless required by job posting.
- Add a summary section highlighting the most relevant experiences.
- Try to preserve the original writing style if possible.
- Avoid leaving an empty space at the bottom of the last page if you have useful content to fill it — but don't spread a nearly-empty second page just to use it.
- PROJECTS: Only include projects directly relevant to this job. Skip projects already listed under Publications. If no projects are relevant, omit the section entirely.
- PUBLICATIONS: Always use "PUBLICATIONS" (plural) as the section title, even for a single item.
- EDUCATION: By default include only the most recent / highest degree. Include multiple degrees only if they are both relevant to the role.
- EXPERIENCE SECTION TITLE: Title the experience section "PROFESSIONAL EXPERIENCE (Last N Contracts)", where N is the exact number of entries you include below it. This frames the listed entries as a selected recent subset rather than a complete career history, so the section doesn't read as contradicting a longer total-years claim made elsewhere (e.g. in the summary).

{content_rules}

CONTENT BUDGET:
- Target: ~{target_words} words, ~{target_chars} characters (higher end is fine for candidates with 7+ years / many roles; these are rough estimates, actual fit depends on formatting)
- The ONLY authoritative check is page_count (and page-2 overflow) from check_content_length

TOOLS:
- REQUIRED: call check_content_length(html) with your final HTML before returning — output is REJECTED if you skip this
  - Returns actual page_count from rendered PDF (authoritative), up to 2 pages allowed
  - Also flags if page 2 is a near-empty overflow (a stray line or two spilling from page 1) — this fails even though page_count==2
  - Also returns character/word estimates (rough guidance only)
  - If fits_page_limit is false, trim content (or add more to fill page 2 properly) and call again until fits_page_limit=true
- OPTIONAL: check_keywords_tool(html) - Returns missing job keywords ranked by TF-IDF importance. Use if unsure about keyword coverage.
- OPTIONAL: validate_structure(html) - Check HTML has proper headers/sections. Use after major structural changes.
- OPTIONAL: preview_resume(html) - Renders PDF preview image. Use to visually check layout.

LINKS:
- Preserve contacts info as in the original and never delete it
- Preserve URLs from the original resume (email, LinkedIn, GitHub, website, project links)
- Use full URLs (include https://) in the href attribute of every <a> tag
- Link display text must NOT start with https:// or http:// — show just the domain+path (e.g. linkedin.com/in/username, github.com/username)

PUBLICATIONS:
- Always append the DOI in parentheses at the end if available, e.g. "Author et al., Title, Venue Year (DOI: 10.xxxx/xxxx)"

PROFILE SOURCE (when input contains "## Contact" or "## Source documents ranked by relevance"):
- The input is a MERGED PROFILE from multiple documents — it contains more content than one resume
- "Candidate name:" field → use as the resume H1 name (first + last name)
- "## Contact" → copy these fields ONLY into the header contact line (email, phone, LinkedIn, GitHub, website)
- "## Additional links" → these are reference links for inline use in projects/publications, NOT for the header
- "## Source documents ranked by relevance" → use to decide which experiences to highlight and trim
- Be selective: include only the 3-5 most relevant experience entries for this specific job
- Summary: 2-3 sentences maximum, tightly focused on this specific role
- Call check_content_length early to check length; trim only if it doesn't fit within 2 pages — do not force it onto 1 page at the cost of readability

{resume_guide}
`;

export const OPTIMIZER_STRICT_RULES = `
ALLOWED:
- You CAN add related technologies plausible from context (e.g. Python user likely knows pip, venv; React user likely knows npm, webpack)
- General/umbrella terms inferable from context: "NLP" if they did text processing, "SQL" if they used databases
- Rephrasing metrics with same values: "1% - 10%" -> "1-10%"
- Reordering and emphasizing existing content
- Using content that is commented out and making it visible
- You CAN use <style> tags if you need custom styling beyond the provided classes

STRICT RULES - NEVER VIOLATE:
- NEVER add specific named products or platforms absent from the original (e.g. "Amazon Bedrock", "LangChain", "Pinecone") unless they are a direct, obvious companion to something explicitly present (e.g. PostgreSQL user → may know MySQL) AND there is no other way to improve fit
- NEVER fabricate job titles, companies, degrees, certifications, or achievements
- NEVER invent metrics, numbers and achievements not in original
- DO NOT drop work experience or achievements (publications, patents, awards, etc.) unless they decrease fit
- Never use the em dash symbol, the word "delve" or other common markers of LLM-generated text.
- NEVER add <script> tags
- Do not cut critical content (like work experience, education, etc) if you can cut something else (like summary)
`;

export const OPTIMIZER_LENIENT_RULES = `
ALLOWED:
- You CAN add related technologies plausible from context (e.g. Python user likely knows pip, venv; React user likely knows npm, webpack)
- You CAN extrapolate skills from adjacent experience
- You CAN make light assumptions about the candidate
- General/umbrella terms inferable from context: "NLP" if they did text processing, "SQL" if they used databases
- Rephrasing metrics with same values: "1% - 10%" -> "1-10%"
- Reordering and emphasizing existing content
- Using content that is commented out and making it visible
- You CAN use <style> tags if you need custom styling beyond the provided classes

STRICT RULES - NEVER VIOLATE:
- NEVER fabricate job titles, companies, degrees, certifications, or achievements
- NEVER invent metrics, numbers and achievements not in original
- Never use the em dash symbol, the word "delve" or other common markers of LLM-generated text.
- NEVER add <script> tags
- Do not cut critical content (like work experience, education, etc) if you can cut something else (like summary)
`;

/** Builds the system prompt from the two slots. */
export const buildSystemPrompt = (opts: { noShame: boolean; targetChars: number; targetWords: number }): string =>
  OPTIMIZER_BASE.replace(
    '{content_rules}',
    opts.noShame ? OPTIMIZER_LENIENT_RULES : OPTIMIZER_STRICT_RULES,
  )
    .replace('{resume_guide}', loadResumeGuide())
    .replace('{target_chars}', String(opts.targetChars))
    .replace('{target_words}', String(opts.targetWords));

/** The date line, appended to the system prompt. */
export const currentDateLine = (now: Date = new Date()): string =>
  `Today's date: ${now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`;

/** One filter outcome, as the prompt shows it. */
export interface FilterReport {
  readonly filterName: string;
  readonly passed: boolean;
  readonly score: number;
  readonly threshold: number;
  readonly issues: readonly string[];
  readonly suggestions: readonly string[];
  /** Skipped filters are left out, as `format_filter_results` leaves them out. */
  readonly skipped?: boolean;
}

/** Port of `IterationContext.format_filter_results()`. */
export const formatFilterResults = (results: readonly FilterReport[]): string => {
  const lines: string[] = [];
  for (const r of results) {
    if (r.skipped === true) continue;
    lines.push(
      `[${r.filterName}] Score: ${r.score.toFixed(2)}/${r.threshold.toFixed(2)} ` +
        `(${r.passed ? 'PASSED' : 'FAILED'})`,
    );
    for (const i of r.issues) lines.push(`  Issue: ${i}`);
    for (const s of r.suggestions) lines.push(`  Suggestion: ${s}`);
  }
  return lines.join('\n');
};

export interface OptimizerPromptInput {
  readonly originalResume: string;
  readonly jobTitle: string;
  readonly jobCompany: string;
  readonly jobRequirements: readonly string[];
  readonly jobKeywords: readonly string[];
  readonly jobDescription: string;
  readonly userInstructions: string | null;
  /** BCP-47 code. The language block is added only if this is not English. */
  readonly languageCode: string;
  /** The previous iteration's HTML, if this is a refinement. */
  readonly lastAttempt: string | null;
  readonly iteration: number;
  /** Rough character and word counts of `lastAttempt`. */
  readonly lastAttemptChars: number;
  readonly lastAttemptWords: number;
  readonly filterResults: readonly FilterReport[];
}

const englishName = (code: string): string => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
};

const nativeName = (code: string): string => {
  try {
    return new Intl.DisplayNames([code], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
};

/** Builds the user prompt. Same order and wording as `optimize_resume()`. */
export const buildUserPrompt = (input: OptimizerPromptInput): string => {
  let prompt = `## Original Resume:
${input.originalResume}

## Job Posting:
Title: ${input.jobTitle}
Company: ${input.jobCompany}
Requirements: ${input.jobRequirements.join(', ')}
Keywords: ${input.jobKeywords.join(', ')}
Description: ${input.jobDescription}
`;

  if (input.userInstructions) {
    prompt += `
## User Instructions:
${input.userInstructions}

IMPORTANT: Treat the above "User Instructions" as GROUND TRUTH about the candidate's preferences or extra experience.
- You MUST incorporate these instructions into the resume if they provide new information (like "I have experience with X").
- If the instructions give stylistic guidance (e.g. "Focus on leadership"), follow them.
- These instructions override the "only use original content" rule because they ARE provided by the user.
`;
  }

  if (input.languageCode !== 'en') {
    const en = englishName(input.languageCode);
    const nat = nativeName(input.languageCode);
    prompt += `
## TARGET LANGUAGE: ${en} (${nat})

Generate the resume HTML in ${en} language.
- Use professional terminology appropriate for the ${en} job market
- Write naturally as a native ${en} speaker — NOT machine translation
- Maintain formal professional resume tone appropriate for ${en}-language resumes
- Keep in English: company names (if originally english), product names, certifications (AWS, PMP), programming languages/frameworks/tools (Python, React, Docker), URLs, email addresses
- Keep widely recognized English technical terms that are standard in ${en}-speaking professional community
- Use accepted ${en} equivalents where they exist and are commonly used
- Text often expands in ${en} vs English — compensate with concise phrasing, shorter synonyms, or abbreviations accepted in ${en} professional context. Do NOT drop content — condense wording instead.
`;
  }

  if (input.lastAttempt) {
    prompt += `
## Last Attempt (Iteration ${input.iteration}):
${input.lastAttempt}

## Current Content Stats:
- Current: ${input.lastAttemptChars} chars, ${input.lastAttemptWords} words

NOTE: This is a REFINEMENT iteration. Make the smallest possible change to pass failed filters.
Do NOT rewrite from scratch - modify the last attempt minimally.
`;
  }

  if (input.filterResults.length > 0) {
    prompt += `
## Filter Results:
${formatFilterResults(input.filterResults)}

IMPORTANT: Make MINIMAL changes to fix ONLY the failed filters.
- Start from the Last Attempt HTML above
- Change ONLY what's needed to pass the failed filter(s)
- Do NOT rewrite, rephrase, or restructure content that isn't causing failures
- Do NOT add new spelling mistakes, keywords, or stylistic changes if they were already added before
- Preserve everything that already works
`;
  }

  prompt += `
Return JSON with:
- html: The HTML body content (no wrapper tags, just the content for <body>)
- changes: List of changes made (for tracking)

Output ONLY valid JSON. The html field should contain the raw HTML string.
`;

  return prompt;
};
