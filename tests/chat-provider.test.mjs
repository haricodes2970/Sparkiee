import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatProvider } from '../packages/server/src/chat-provider.mjs';

function loadedConfig(overrides = {}) {
  return {
    configured: true,
    provider: 'groq',
    config: {
      provider: 'groq',
      providers: {
        groq: { apiKey: 'gsk_test_key_0123456789abcdefghij', model: 'openai/gpt-oss-20b' },
        google: { apiKey: 'AIzaSyA1234567890abcdefghijklmnopqrstuv', model: 'gemini-2.5-flash' },
      },
      localOnly: false,
    },
    warnings: [],
    source: 'file',
    ...overrides,
  };
}

test('chat provider translates (messages, options) into the client object shape', async () => {
  const messages = [
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'Hello' },
  ];
  let received = null;
  const provider = createChatProvider({
    getChatConfig: () => loadedConfig(),
    makeClient: (options) => ({
      options,
      chat: async (input) => {
        received = input;
        return { ok: true, text: 'Hi', model: 'openai/gpt-oss-20b', usage: null };
      },
    }),
  });

  const result = await provider.chat(messages, { maxTokens: 123, temperature: 0.2 });

  assert.equal(result.ok, true);
  assert.equal(received.messages, messages);
  assert.equal(received.maxTokens, 123);
  assert.equal(received.temperature, 0.2);
});

test('chat provider reports configured and local-only states honestly', () => {
  const provider = createChatProvider({ getChatConfig: () => loadedConfig() });
  assert.equal(provider.configured(), true);
  assert.equal(provider.describe().provider, 'groq');

  const local = createChatProvider({
    getChatConfig: () => loadedConfig({ config: { ...loadedConfig().config, localOnly: true } }),
  });
  assert.equal(local.configured(), false);
  assert.equal(local.describe().localOnly, true);
});
