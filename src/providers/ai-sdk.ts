import { createDeepSeek } from '@ai-sdk/deepseek';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateObject, generateText } from 'ai';
import type { LanguageModel } from 'ai';
import type { z } from 'zod';
import type { ChatProvider, ChatRequest } from './llm.ts';

/**
 * ChatProvider backed by the Vercel AI SDK.
 *
 * Model strings use a `provider/model` shape, for example
 * `deepseek/deepseek-v4-flash` or `gemini/gemini-2.5-flash`.
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
 * not. See docs/design-notes.md.
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
    case 'ollama': {
      // A LOCAL MODEL, THROUGH THE OPENAI-COMPATIBLE ENDPOINT.
      //
      // ollama serves /v1 in the OpenAI shape, and createDeepSeek IS an
      // OpenAI-compatible client with a base URL - so this needs no new
      // dependency. The key is required by the client and ignored by ollama.
      //
      // BUDGET FOR THE THINKING. qwen3 emits a reasoning block before its
      // answer and it is charged to the SAME output budget: measured
      // 2026-09-27, "Reply with exactly: OK" spent 179 output tokens and
      // returned an EMPTY string under a 20-token cap. A caller that sets a
      // small maxOutputTokens here gets silence, not an error.
      const host = process.env['OLLAMA_URL'] ?? 'http://localhost:11434';
      return {
        provider,
        model: createDeepSeek({ baseURL: `${host.replace(/\/+$/, '')}/v1`, apiKey: 'ollama' })(
          name,
        ),
      };
    }
    case 'gemini':
    case 'google':
      // Accepts GOOGLE_GENERATIVE_AI_API_KEY, and GEMINI_API_KEY as an alias.
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
      // image makes the vision filter grade the wrong thing, silently.
      throw new Error(`provider ${provider} cannot accept images`);
    }
    return {
      system: req.system,
      messages: [
        {
          role: 'user' as const,
          content: [
            { type: 'text' as const, text: req.prompt },
            // A `file` part, not the deprecated `image` part. This is the path
            // that carries the page image. Keep it on a supported API.
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
