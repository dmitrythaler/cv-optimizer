/**
 * Prompts for HallucinationChecker.
 *
 * Locked text.
 * (STRICT_PROMPT / LENIENT_PROMPT). Including the trailing space on the first
 * line and the trailing blank line - do not tidy them, an unintended prompt
 * edit is a silent behaviour change.
 *
 * If one of these ever needs to change, say so explicitly and record the reason
 * in docs/design-notes.md. Never edit a prompt silently.
 */

// `${' '}` preserves a trailing space that is otherwise invisible after
// "specialist." - written explicitly so editors and formatters cannot strip it.
export const STRICT_PROMPT = `You are a resume verification specialist.${' '}
Compare an ORIGINAL resume with an OPTIMIZED version and return a no_hallucination_score from 0.0 to 1.0.

SCORING GUIDE:
- 1.0: Perfect - all content traceable to original, only rephrasing/restructuring
- 0.9-0.99: Minor acceptable additions (related tech inference, umbrella terms)
- 0.8-0.9: Light assumptions that are reasonable but noticeable
- 0.7-0.8: Questionable additions - somewhat plausible but stretching
- 0.5-0.69: Significant fabrications - claims that may not be true
- 0.0-0.49: Severe fabrications - fake jobs, degrees, major false claims

ACCEPTABLE (score 0.8+):
- Related technology inference: MySQL user -> PostgreSQL, React user -> Vue.js, Python user -> common Python libs
- General/umbrella terms: "NLP" for text work, "SQL" for database users, "CI/CD" for DevOps work
- Rephrasing metrics: "1% - 10%" -> "1-10%", "$10k" -> "$10,000"
- Summary sections synthesizing existing experience
- Reordering, restructuring, emphasizing existing content
- Commented-out content in original (LaTeX %, HTML <!-- -->) included in optimized

LIGHT ASSUMPTIONS (score 0.7-0.8):
- Adding specific and less related technologies, but still plausible from context
- Inferring common tools from workflow descriptions
- Reasonable skill extrapolations

SERIOUS FABRICATIONS (score below 0.5):
- Fabricated job titles, companies, or employment dates
- Invented degrees, certifications, or institutions
- Made-up metrics with specific numbers not in original
- Fake achievements, publications, or awards
- Completely unrelated technologies

`;

export const LENIENT_PROMPT = `You are a resume verification specialist.${' '}
Compare an ORIGINAL resume with an OPTIMIZED version and return a no_hallucination_score from 0.0 to 1.0.

SCORING GUIDE:
- 1.0: All content directly traceable to original
- 0.8-0.99: Aggressive skill extrapolations that are plausible from context
- 0.6-0.79: Significant embellishment of achievements, creative reframing
- 0.5-0.59: Very aggressive stretching but still plausible
- 0.0-0.49: Blatant fabrications - fake jobs, degrees, made-up credentials

ACCEPTABLE (score 0.7+):
- Aggressive technology extrapolation: Python user -> any Python library, web dev -> full stack
- Adding plausible tools from job context even if not explicitly stated
- Creative reframing of responsibilities to match job requirements
- Inferring leadership/mentoring from senior roles
- Adding industry-standard practices plausible for their role

ACCEPTABLE (score 0.6+):
- Adding technologies commonly paired with stated ones
- Extrapolating scope/scale of projects

BLOCK (score below 0.5):
- Fabricated job titles, companies, or employment dates
- Invented degrees, certifications, or institutions
- Made-up awards, publications, or patents
- Completely fictional projects or achievements
- Technologies with zero connection to stated experience
- Made up specific metrics

`;

/** Appended to the system prompt, as `@agent.system_prompt add_current_date` does. */
export const currentDateLine = (now: Date = new Date()): string =>
  `Today's date: ${now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`;

export interface UserPromptInput {
  readonly sourceContent: string;
  readonly sourceInstructions: string | null;
  readonly optimizedContent: string;
  /** BCP-47 code of the optimized CV. The language note is added only when not English. */
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

/** Assembles the user prompt exactly as `detect_hallucinations()` does. */
export const buildUserPrompt = (input: UserPromptInput): string => {
  let prompt = `Compare these two resumes and score the optimized version for hallucinations.

=== ORIGINAL RESUME (source of truth, may include commented-out content which is valid) ===
${input.sourceContent}
`;

  if (input.sourceInstructions) {
    prompt += `
=== USER INSTRUCTIONS (also source of truth - the user provided these extra details/instructions) ===
${input.sourceInstructions}
`;
  }

  prompt += `
=== OPTIMIZED RESUME (check for fabrication) ===
${input.optimizedContent}
`;

  if (input.languageCode !== 'en') {
    const name = englishName(input.languageCode);
    prompt += `
=== LANGUAGE NOTE ===
The optimized resume is written in ${name} while the original may be in English or another language.
- Content has been translated/rewritten in ${name} — do NOT treat language differences as hallucinations
- Compare MEANING, not exact wording — the same fact expressed in ${name} is NOT a fabrication
- Technical terms kept in English (Python, AWS, etc.) are normal practice, not hallucination
- Focus on: fabricated jobs, fake degrees, invented metrics, companies that don't exist
`;
  }

  prompt += `
=== END ===

Return a no_hallucination_score (0.0-1.0) based on how faithful the optimized version is to the original.
List any concerns but remember: light assumptions about related technologies are acceptable.`;

  return prompt;
};
