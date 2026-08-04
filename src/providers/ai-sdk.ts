import { createDeepSeek } from '@ai-sdk/deepseek';
import { generateObject, generateText } from 'ai';
import type { LanguageModel } from 'ai';
import type { z } from 'zod';
import type { ChatProvider, ChatRequest } from './llm.ts';

/**
 * ChatProvider backed by the Vercel AI SDK.
 *
 * Model strings keep hr-breaker's `provider/model` shape (e.g.
 * `deepseek/deepseek-chat`) so the two projects stay configurable the same way.
 */

/** Providers that can accept an image. Checked before a vision call is attempted. */
const VISION_CAPABLE = new Set<string>([]);

const resolve = (spec: string): { provider: string; model: LanguageModel } => {
  const slash = spec.indexOf('/');
  if (slash <= 0 || slash === spec.length - 1) {
    throw new Error(`model must be "provider/model", got ${JSON.stringify(spec)}`);
  }
  const provider = spec.slice(0, slash);
  const name = spec.slice(slash + 1);

  switch (provider) {
    case 'deepseek':
      return { provider, model: createDeepSeek({})(name) };
    default:
      throw new Error(
        `unsupported chat provider ${JSON.stringify(provider)} - add it in providers/ai-sdk.ts`,
      );
  }
};

export const aiSdkChat = (spec: string): ChatProvider => {
  const { provider, model } = resolve(spec);

  const messages = (req: ChatRequest) => {
    if (req.image === undefined) return { system: req.system, prompt: req.prompt };
    if (!VISION_CAPABLE.has(provider)) {
      // Better to refuse than to send the image and have it silently dropped -
      // that is precisely how hr-breaker's vision filter came to grade the
      // wrong thing for weeks. See docs/porting-notes.md.
      throw new Error(`provider ${provider} cannot accept images`);
    }
    return {
      system: req.system,
      messages: [
        {
          role: 'user' as const,
          content: [
            { type: 'text' as const, text: req.prompt },
            { type: 'image' as const, image: req.image },
          ],
        },
      ],
    };
  };

  return {
    model: spec,
    supportsVision: () => VISION_CAPABLE.has(provider),

    complete: async (req) => {
      const { text } = await generateText({ model, ...messages(req) });
      return text;
    },

    object: async <T>(req: ChatRequest, schema: z.ZodType<T>): Promise<T> => {
      const { object } = await generateObject({ model, schema, ...messages(req) });
      return object;
    },
  };
};
