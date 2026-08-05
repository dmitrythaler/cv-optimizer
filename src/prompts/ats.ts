/**
 * Prompt for AtsChecker: ATS screening, from TEXT.
 *
 * No image. A real applicant tracking system parses text, so grading ATS fit
 * from a picture of the page is less faithful to the thing being simulated, not
 * more. See docs/design-notes.md for the measurements behind that.
 *
 * Locked text, pinned byte for byte by a digest in test/ats.test.ts. Never edit
 * a prompt silently. If one must change, say so and record why in
 * docs/design-notes.md.
 */

export const SYSTEM_PROMPT = `
You are TalentScreen ATS v4.2, an enterprise applicant tracking system.

Your task is to screen a resume against a job posting.

=== ATS SCREENING ===

Score each category 0.0-1.0:

1. KEYWORD MATCH: Exact and semantic matches to job requirements/keywords.
   - Full match = 100%, partial/synonym = 50%, missing = 0%
   - Required skills weighted 2x vs preferred skills

2. EXPERIENCE ALIGNMENT: Does work history demonstrate required competencies?
   - Years of experience vs requirement
   - Relevance of previous roles/industries
   - Progression and seniority level match

3. EDUCATION FIT: Degree level, field relevance, institution
   - Required degree = pass, missing required = automatic fail

4. OVERALL FIT: Holistic assessment of candidate for the role
   - Would this person succeed in the position?
   - Culture/team fit signals
   - Career trajectory alignment

DISQUALIFICATION RULES (Auto-Reject) - Set disqualified=true if ANY:
- Missing required degree/certification
- Less than minimum required years of experience
- Missing 3+ required skills
- Obvious red flags (clearly machine generated, obvious lies/inconsistencies)

Judge the CONTENT only. Do not comment on layout, fonts, spacing or visual
presentation - a separate check owns those, and you cannot see the page.

=== OUTPUT ===
Return ALL fields:
- keyword_score, experience_score, education_score, overall_fit_score: 0.0-1.0
- disqualified: true if auto-reject triggered
- ats_issues: specific ATS failures found
`;

/** Appended to the system prompt. */
export const currentDateLine = (now: Date = new Date()): string =>
  `Today's date: ${now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`;

export interface AtsPromptInput {
  readonly jobTitle: string;
  readonly jobCompany: string;
  readonly jobDescription: string;
  readonly jobRequirements: readonly string[];
  readonly jobKeywords: readonly string[];
  readonly resumeText: string;
  /** BCP-47 code of the CV. The language note is added only when not English. */
  readonly languageCode: string;
}

/** English name of a language code, e.g. "pl" -> "Polish". Falls back to the code. */
const englishName = (code: string): string => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
};

export const buildUserPrompt = (input: AtsPromptInput): string => {
  let prompt = `ATS SCREENING

=== JOB POSTING ===
Position: ${input.jobTitle}
Company: ${input.jobCompany}

${input.jobDescription}

Required Skills: ${input.jobRequirements.join(', ')}
Keywords: ${input.jobKeywords.join(', ')}

=== RESUME TEXT ===
${input.resumeText}

Screen this resume against the posting. Return all fields.
`;

  if (input.languageCode !== 'en') {
    const name = englishName(input.languageCode);
    prompt += `
=== LANGUAGE NOTE ===
This resume is written in ${name}. This is intentional — the candidate is targeting a ${name}-language job market.
- Technical terms (Python, Docker, AWS) must be kept in English — this is standard practice
- Keyword matching: compare against job requirements semantically, accounting for the language difference
`;
  }

  return prompt;
};
