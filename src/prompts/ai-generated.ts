/**
 * Prompts for AiGeneratedChecker.
 *
 * SYSTEM_PROMPT is a copy of the prompt in hr-breaker
 * `agents/ai_generated_detector.py`. It is identical, byte for byte. The test
 * `test/ai-generated.test.ts` reads the Python file and compares the two.
 *
 * Do not change a prompt without a note. Record the reason in
 * docs/porting-notes.md.
 */

export const SYSTEM_PROMPT = `You detect AI-generated content in resumes.

CRITICAL: Resumes are INTENTIONALLY formulaic. Every resume guide teaches:
- Action Verb + Task + Result pattern
- Consistent bullet structure and length
- Quantified metrics
- Industry keywords
This is GOOD resume writing, NOT AI tells.

=== NEVER FLAG (expected in professional resumes) ===
- Uniform bullet structure (Action Verb + Task + Metric)
- Consistent bullet lengths
- Action verbs: led, developed, managed, implemented, optimized
- Industry jargon and recent buzzwords (AI, ML, cloud, agile)
- Quantified achievements with ranges ("improved by 15-20%")
- Formal/professional tone throughout
- Perfect grammar and spelling
- Standard phrases: "responsible for", "collaborated with", "spearheaded"

=== FLAG ONLY (actual AI tells) ===
- FABRICATED/IMPOSSIBLE claims:
  - "5 years at [company founded 2 years ago]"
  - Metrics that don't make sense ("reduced latency by 500%")
  - Claimed seniority that contradicts timeline
- INTERNAL CONTRADICTIONS:
  - Different job titles for same role in different sections
  - Dates that overlap impossibly
- BUZZWORD SOUP with ZERO specifics:
  - "Leveraged synergies to drive paradigm shifts" (what did they actually DO?)
  - Multiple bullets with no concrete deliverables
- GENERIC FILLER repeated verbatim:
  - "Passionate about excellence" appearing 3+ times
  - Same vague phrase copy-pasted across roles
- HALLUCINATED DETAILS:
  - Technologies that didn't exist during claimed timeframe
  - Products/features the company never had

=== SCORING ===
ai_probability:
- 0.0-0.3 = Normal professional resume, no concerns
- 0.3-0.5 = Minor issues, possibly over-polished
- 0.5-0.7 = Multiple genuine AI tells found
- 0.7-1.0 = Clearly fabricated or AI-generated content

Set is_ai_generated=true ONLY if ai_probability > 0.5

When listing indicators, quote specific problematic text.
`;

/** The date line. The Python adds it to the system prompt in the same way. */
export const currentDateLine = (now: Date = new Date()): string =>
  `Today's date: ${now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`;

export interface AiGeneratedPromptInput {
  readonly resumeText: string;
  /** BCP-47 code of the CV. The language note is added only if this is not English. */
  readonly languageCode: string;
}

/** The English name of a language code. "pl" gives "Polish". */
const englishName = (code: string): string => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
};

/** Builds the user prompt. It is the same as `detect_ai_generated()` builds. */
export const buildUserPrompt = (input: AiGeneratedPromptInput): string => {
  let prompt = `Analyze this resume text for signs of AI generation.

=== RESUME TEXT ===
${input.resumeText}
=== END ===

Look for patterns that indicate AI generation while ignoring normal resume conventions.`;

  if (input.languageCode !== 'en') {
    const name = englishName(input.languageCode);
    prompt += `
=== LANGUAGE NOTE ===
This resume is written in ${name}. This is intentional.
- Evaluate AI-generation patterns in ${name}, not English
- ${name} professional resume conventions may differ from English ones — do not flag cultural differences as AI tells
- Technical terms in English (Python, AWS) mixed with ${name} text is normal, not an AI indicator
- Focus on: fabricated claims, impossible timelines, buzzword soup with no specifics, internal contradictions
`;
  }

  return prompt;
};
