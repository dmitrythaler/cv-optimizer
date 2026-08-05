import { z } from 'zod';
import { logger } from './logger.ts';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompts/job-parser.ts';
import type { ChatProvider } from './providers/llm.ts';
import type { JobPosting } from './types.ts';

/**
 * Turns job posting text into the structured fields the filters need.
 *
 * It runs
 * on the flash model.
 *
 * This matters more than it looks. Without it, `title`, `company`,
 * `requirements` and `keywords` are all empty, so KeywordMatcher scores against
 * the description alone and the output file cannot be named after the job.
 */

export const parsedJob = z.object({
  title: z.string().describe('The job title'),
  company: z.string().describe('Company name'),
  requirements: z
    .array(z.string())
    .default([])
    .describe('List of specific requirements (skills, experience, education)'),
  keywords: z
    .array(z.string())
    .default([])
    .describe('Technical keywords, tools, technologies mentioned'),
  language_code: z.string().default('en').describe("ISO 639-1 code of the job posting's language"),
  description: z.string().describe('Brief summary of the role'),
});

export type ParsedJob = z.infer<typeof parsedJob>;

export const parseJobPosting = async (text: string, chat: ChatProvider): Promise<JobPosting> => {
  const r = await chat.object({ system: SYSTEM_PROMPT, prompt: buildUserPrompt(text) }, parsedJob);

  logger.info(
    `job: "${r.title}" at "${r.company}" - ${r.requirements.length} requirements, ` +
      `${r.keywords.length} keywords, language ${r.language_code}`,
  );

  return {
    title: r.title,
    company: r.company,
    // The parser's brief summary. KeywordMatcher and
    // VectorSimilarityMatcher score against title + description + requirements,
    // so they see the summary, NOT the whole posting. The full text stays in
    // rawText for VisionChecker's fallback.
    description: r.description,
    rawText: text,
    requirements: r.requirements,
    keywords: r.keywords,
    language: r.language_code,
  };
};
