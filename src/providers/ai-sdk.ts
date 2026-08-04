import { createDeepSeek } from '@ai-sdk/deepseek';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateObject, generateText } from 'ai';
import type { LanguageModel } from 'ai';
import type { z } from 'zod';
import type { ChatProvider, ChatRequest } from './llm.ts';

/**
 * ChatProvider backed by the Vercel AI SDK.
 *
 * Model strings keep hr-breaker's `provider/model` shape, for example
 * `deepseek/deepseek-v4-flash` or `gemini/gemini-2.5-flash`. The two projects
 * are then configured the same way.
 */

/**
 * Providers that accept an image.
 *
 * DeepSeek is NOT in this set, and that is a measured fact, not caution.
 * Tested against api.deepseek.com on 2026-08-04: every content-part shape
 * (`image_url`, `image`, `input_image`), the `/beta` endpoint and every model
 * id return the same 400 - "unknown variant `image_url`, expected `text`".
 * The error does not change with the model, so the request schema itself has
 * no image variant. The DeepSeek app has a vision mode; the public API does
 * not. See docs/porting-notes.md.
 */
const VISION_CAPABLE = new Set<string>(['gemini', 'google']);

/**
 * Resolves a `provider/model` spec to an AI SDK model.
 *
 * Exported ONLY for the generator, which needs tool calling and so cannot go
 * through the narrow `ChatProvider` seam. Filters must keep using
 * `ChatProvider`. This is the one deliberate leak of the SDK past this file.
 */
export const resolveModel = (spec: string): { provider: string; model: LanguageModel } => {
  const slash = spec.indexOf('/');
  if (slash <= 0 || slash === spec.length - 1) {
    throw new Error(`model must be "provider/model", got ${JSON.stringify(spec)}`);
  }
  const provider = spec.slice(0, slash);
  const name = spec.slice(slash + 1);

  switch (provider) {
    case 'deepseek':
      return { provider, model: createDeepSeek({})(name) };
    case 'gemini':
    case 'google':
      // Accepts GOOGLE_GENERATIVE_AI_API_KEY. GEMINI_API_KEY is the name
      // hr-breaker uses, so it is accepted too.
      return {
        provider,
        model: createGoogleGenerativeAI({
          apiKey: process.env['GOOGLE_GENERATIVE_AI_API_KEY'] ?? process.env['GEMINI_API_KEY'],
        })(name),
      };
    default:
      throw new Error(
        `unsupported chat provider ${JSON.stringify(provider)} - add it in providers/ai-sdk.ts`,
      );
  }
};

export const aiSdkChat = (spec: string): ChatProvider => {
  const { provider, model } = resolveModel(spec);

  const messages = (req: ChatRequest) => {
    if (req.image === undefined) return { system: req.system, prompt: req.prompt };
    if (!VISION_CAPABLE.has(provider)) {
      // Refuse, rather than send an image the provider will drop. A dropped
      // image is what made hr-breaker's vision filter grade the wrong thing
      // for weeks. See docs/porting-notes.md.
      throw new Error(`provider ${provider} cannot accept images`);
    }
    return {
      system: req.system,
      messages: [
        {
          role: 'user' as const,
          content: [
            { type: 'text' as const, text: req.prompt },
            // A `file` part, not the deprecated `image` part. This is the
            // path that carried the page image, and it was broken for weeks in
            // hr-breaker. Keep it on a supported API.
            { type: 'file' as const, data: req.image, mediaType: 'image/png' },
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

/** The three models the filters use. Built once and shared. */
export interface ChatProviders {
  readonly pro: ChatProvider;
  readonly flash: ChatProvider;
  readonly vision: ChatProvider;
}

export const aiSdkProviders = (models: {
  pro: string;
  flash: string;
  vision: string;
}): ChatProviders => ({
  pro: aiSdkChat(models.pro),
  flash: aiSdkChat(models.flash),
  vision: aiSdkChat(models.vision),
});
