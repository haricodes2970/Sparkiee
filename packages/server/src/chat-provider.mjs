import { describeChatConfig, CHAT_PROVIDER_INFO } from '../../core/src/chat-config.mjs';
import { createChatClient } from '../../core/src/chat-client.mjs';

/**
 * Adapter between the server's small chat surface and the provider client.
 * The server passes `(messages, options)`; the client accepts one object, so
 * this is the single place that owns the translation.
 */
export function createChatProvider({ getChatConfig, makeClient = createChatClient } = {}) {
  return {
    configured() {
      const loaded = getChatConfig();
      return loaded.configured === true && loaded.config.localOnly !== true;
    },
    describe() {
      return describeChatConfig(getChatConfig());
    },
    chat(messages, options = {}) {
      const loaded = getChatConfig();
      const active = loaded.provider;
      const entry = loaded.config.providers?.[active] ?? {};
      const client = makeClient({
        provider: active,
        config: {
          apiKey: entry.apiKey ?? null,
          model: entry.model ?? null,
          baseUrl: CHAT_PROVIDER_INFO[active].baseUrl,
          localOnly: loaded.config.localOnly === true,
        },
      });
      return client.chat({ messages, ...options });
    },
  };
}
