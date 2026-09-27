import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveModel } from '../src/providers/ai-sdk.ts';

test('resolveModel: ollama resolves, and keeps the colon in the model name', () => {
  // "ollama/qwen3:14b" must split on the FIRST slash only. A model name with a
  // colon is normal for ollama and must survive intact.
  const r = resolveModel('ollama/qwen3:14b');
  assert.equal(r.provider, 'ollama');
  assert.ok(r.model);
});

test('resolveModel: the existing providers still resolve', () => {
  assert.equal(resolveModel('deepseek/deepseek-v4-pro').provider, 'deepseek');
  assert.equal(resolveModel('gemini/gemini-3.5-flash').provider, 'gemini');
});

test('resolveModel: a bad spec throws rather than guessing', () => {
  for (const bad of ['qwen3:14b', '/qwen3', 'ollama/', '']) {
    assert.throws(() => resolveModel(bad), /provider\/model/, bad);
  }
  assert.throws(() => resolveModel('llamacpp/foo'), /unsupported chat provider/);
});
