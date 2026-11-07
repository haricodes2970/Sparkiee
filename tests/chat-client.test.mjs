import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_ERROR_MESSAGES, createChatClient } from '../packages/core/src/chat-client.mjs';
import { containsSecretLike, redactSecrets } from '../packages/core/src/secret-redaction.mjs';

const GROQ_KEY = 'gsk_abcdefghijklmnopqrstuvwxyz0123456789';
const GOOGLE_KEY = 'AIzaSyA1234567890abcdefghijklmnopqrstuv';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const GOOGLE_MODEL = 'gemini-2.5-flash';

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body ?? {})),
  };
}

function clientFor(provider, handler, overrides = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return handler(url, options);
  };
  const config = provider === 'groq'
    ? { apiKey: GROQ_KEY, model: GROQ_MODEL, baseUrl: 'https://api.groq.com/openai/v1', localOnly: false }
    : { apiKey: GOOGLE_KEY, model: GOOGLE_MODEL, baseUrl: 'https://generativelanguage.googleapis.com/v1beta', localOnly: false };
  const client = createChatClient({ provider, config, fetchImpl, ...overrides });
  return { client, calls };
}

test('groq posts an OpenAI-compatible body and parses the reply', async () => {
  const { client, calls } = clientFor('groq', () => jsonResponse(200, {
    model: GROQ_MODEL,
    choices: [{ message: { role: 'assistant', content: '  Hello there.  ' } }],
    usage: { total_tokens: 12 },
  }));
  const result = await client.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'Hello there.');
  assert.equal(calls[0].url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(calls[0].options.headers.authorization, `Bearer ${GROQ_KEY}`);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, GROQ_MODEL);
  assert.equal(body.stream, false);
  assert.ok(body.max_tokens > 0 && body.max_tokens <= 2048);
});

test('google sends the key in a header (never the URL) and reads candidate parts', async () => {
  const { client, calls } = clientFor('google', () => jsonResponse(200, {
    candidates: [{ content: { role: 'model', parts: [{ text: ' Namaste! ' }, { text: 'How are you?' }] }, finishReason: 'STOP' }],
    usageMetadata: { totalTokenCount: 21 },
  }));
  const result = await client.chat({ messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }] });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'Namaste! How are you?');
  assert.match(calls[0].url, /\/models\/gemini-2\.5-flash:generateContent$/);
  assert.ok(!calls[0].url.includes(GOOGLE_KEY), 'key is not in the URL');
  assert.equal(calls[0].options.headers['x-goog-api-key'], GOOGLE_KEY);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.systemInstruction.parts[0].text, 'be brief');
  assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: 'hi' }] }]);
});

test('google maps assistant turns to the model role', async () => {
  const { client, calls } = clientFor('google', () => jsonResponse(200, { candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
  await client.chat({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }] });
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.contents.map((entry) => entry.role), ['user', 'model', 'user']);
});

test('model discovery works for both providers and ignores non-chat entries', async () => {
  const groq = clientFor('groq', () => jsonResponse(200, { data: [{ id: GROQ_MODEL }, { id: 'whisper-large-v3' }, { nope: true }, 'x'] }));
  const groqList = await groq.client.listModels();
  assert.equal(groqList.ok, true);
  assert.ok(groqList.models.includes(GROQ_MODEL));
  assert.ok(!groqList.models.includes('x'));

  const google = clientFor('google', () => jsonResponse(200, {
    models: [
      { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
    ],
  }));
  const googleList = await google.client.listModels();
  assert.equal(googleList.ok, true);
  assert.deepEqual(googleList.models, ['gemini-2.5-flash']);
});

test('provider status codes map to stable, explainable error codes', async () => {
  const cases = [[401, 'auth'], [403, 'auth'], [404, 'model_not_found'], [429, 'rate_limited'], [400, 'provider_error'], [500, 'provider_error'], [503, 'provider_error']];
  for (const [status, expected] of cases) {
    const { client } = clientFor('groq', () => jsonResponse(status, { error: { message: 'nope' } }));
    const result = await client.chat({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(result.ok, false, `HTTP ${status} fails`);
    assert.equal(result.error.code, expected, `HTTP ${status} → ${expected}`);
    assert.ok(result.error.message.length > 10);
  }
});

test('a provider error that echoes the key is redacted before it can be shown', async () => {
  const groq = clientFor('groq', () => jsonResponse(401, `{"error":"invalid key: ${GROQ_KEY}"}`));
  const result = await groq.client.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.ok(!JSON.stringify(result).includes(GROQ_KEY));
  assert.match(result.error.detail, /redacted/);

  const google = clientFor('google', () => jsonResponse(403, `{"error":{"message":"bad ${GOOGLE_KEY}"}}`));
  assert.ok(!JSON.stringify(await google.client.chat({ messages: [{ role: 'user', content: 'hi' }] })).includes(GOOGLE_KEY));
});

test('network and timeout failures are distinguished and never throw', async () => {
  const network = createChatClient({
    provider: 'groq',
    config: { apiKey: GROQ_KEY, model: GROQ_MODEL, baseUrl: 'https://x/v1', localOnly: false },
    fetchImpl: async () => { throw new TypeError('fetch failed'); },
  });
  assert.equal((await network.chat({ messages: [{ role: 'user', content: 'hi' }] })).error.code, 'network');

  const timeout = createChatClient({
    provider: 'google',
    config: { apiKey: GOOGLE_KEY, model: GOOGLE_MODEL, baseUrl: 'https://x/v1beta', localOnly: false },
    fetchImpl: async () => { const error = new Error('aborted'); error.name = 'AbortError'; throw error; },
  });
  assert.equal((await timeout.chat({ messages: [{ role: 'user', content: 'hi' }] })).error.code, 'timeout');
});

test('empty, unparseable, or safety-blocked replies are honest errors', async () => {
  const empty = clientFor('groq', () => jsonResponse(200, { choices: [{ message: { content: '   ' } }] }));
  assert.equal((await empty.client.chat({ messages: [{ role: 'user', content: 'hi' }] })).error.code, 'empty_reply');

  const junk = clientFor('groq', () => jsonResponse(200, 'not json at all'));
  assert.equal((await junk.client.chat({ messages: [{ role: 'user', content: 'hi' }] })).error.code, 'empty_reply');

  const blocked = clientFor('google', () => jsonResponse(200, { promptFeedback: { blockReason: 'SAFETY' } }));
  assert.equal((await blocked.client.chat({ messages: [{ role: 'user', content: 'hi' }] })).error.code, 'blocked');

  const stopped = clientFor('google', () => jsonResponse(200, { candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] }));
  assert.equal((await stopped.client.chat({ messages: [{ role: 'user', content: 'hi' }] })).error.code, 'blocked');
});

test('local-only and unconfigured clients never reach the network', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return jsonResponse(200, {}); };
  const localOnly = createChatClient({
    provider: 'groq',
    config: { apiKey: GROQ_KEY, model: GROQ_MODEL, baseUrl: 'https://x/v1', localOnly: true },
    fetchImpl,
  });
  assert.equal((await localOnly.chat({ messages: [{ role: 'user', content: 'hi' }] })).error.code, 'local_only');

  const unconfigured = createChatClient({
    provider: 'google',
    config: { apiKey: null, model: null, baseUrl: 'https://x/v1beta', localOnly: false },
    fetchImpl,
  });
  assert.equal(unconfigured.configured, false);
  assert.equal((await unconfigured.chat({ messages: [{ role: 'user', content: 'hi' }] })).error.code, 'not_configured');
  assert.equal((await unconfigured.listModels()).error.code, 'not_configured');
  assert.equal(called, false, 'no request left the machine');
});

test('every chat error code has a human message', () => {
  for (const [code, message] of Object.entries(CHAT_ERROR_MESSAGES)) {
    assert.equal(typeof code, 'string');
    assert.ok(message.length > 15, `${code} message is actionable`);
    assert.match(message, /[a-z]/i, `${code} message is human readable`);
  }
});

test('redactSecrets removes bearer headers, labelled values, and raw tokens', () => {
  const samples = [
    `Authorization: Bearer ${GROQ_KEY}`,
    `api_key=${GROQ_KEY}`,
    `"apiKey": "${GROQ_KEY}"`,
    `token: ${GROQ_KEY}`,
    `secret = ${GROQ_KEY}`,
    `invalid ${GROQ_KEY} supplied`,
    `x-goog-api-key: ${GOOGLE_KEY}`,
  ];
  for (const sample of samples) {
    const out = redactSecrets(sample);
    assert.ok(!out.includes(GROQ_KEY) && !out.includes(GOOGLE_KEY), `token removed from: ${sample}`);
    assert.match(out, /redacted/i);
  }
  assert.equal(redactSecrets('plain text, nothing secret'), 'plain text, nothing secret');
  assert.equal(containsSecretLike(`Bearer ${GROQ_KEY}`), true);
  assert.equal(containsSecretLike('play Madira on the speakers'), false);
});
