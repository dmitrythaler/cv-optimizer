/**
 * Prompt for the job parser.
 *
 * A copy of the prompt in hr-breaker `agents/job_parser.py`, identical byte for
 * byte. `test/job-parser.test.ts` reads the Python file and compares.
 *
 * Do not change a prompt without a note. Record the reason in
 * docs/porting-notes.md.
 */

export const SYSTEM_PROMPT = `You are a job posting parser. Extract structured information from job postings.

Extract:
- title: The job title
- company: Company name
- requirements: List of specific requirements (skills, experience, education)
- keywords: Technical keywords, tools, technologies mentioned
- language_code: ISO 639-1 code of the job posting's language (e.g. "en", "ru")
- description: Brief summary of the role

Be thorough in extracting keywords - include all technologies, tools, frameworks, methodologies mentioned.
`;

/** The user prompt, as `parse_job_posting()` builds it. */
export const buildUserPrompt = (text: string): string => `Parse this job posting:\n\n${text}`;
