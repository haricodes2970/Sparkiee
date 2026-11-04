import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_ERROR_MESSAGES, createNvidiaChatClient } from '../packages/core/src/chat-client.mjs';
import { containsSecretLike, redactSecrets } from '../packages/core/src/secret-redaction.mjs';

const KEY = 'nvapi-abcdefghijklmnopqrstuvwxyz0123456789';
const MODEL = 'meta/llama-3.1-8b-instruct';

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body ?? {})),
  };
}

function clientWith(handler, overrides = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return handler(url, options);
  };
  const client = createNvidiaChatClient({
    config: { apiKey: KEY, model: MODEL, baseUrl: 'https://integrate.api.nvidia.com/v1', localOnly: false },
    fetchImpl,
    ...overrides,
  });
  return { client, calls };
}

test('chat posts the OpenAI-compatible body with the model and bounded messages', async () => {
  const { client, calls } = clientWith(() => jsonResponse(200, {
    model: MODEL,
    choices: [{ message: { role: 'assistant', content: '  Hello there.  ' } }],
    usage: { total_tokens: 12 },
  }));
  const result = await client.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'Hello there.', 'content trimmed');
  assert.equal(result.model, MODEL);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://integrate.api.nvidia.com/v1/chat/completions');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.authorization, `Bearer ${KEY}`);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, MODEL);
  assert.equal(body.stream, false);
  assert.equal(body.messages[0].role, 'user');
  assert.ok(body.max_tokens > 0 && body.max_tokens <= 2048);
});

test('listModels reads the live model ids and ignores malformed entries', async () => {
  const { client, calls } = clientWith(() => jsonResponse(200, {
    data: [{ id: MODEL }, { id: 'nvidia/embed-qa' }, { nope: true }, { id: '' }, 'x'],
  }));
  const listed = await client.listModels();
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.models, [MODEL, 'nvidia/embed-qa']);
  assert.equal(calls[0].url, 'https://integrate.api.nvidia.com/v1/models');
  assert.equal(calls[0].options.method, 'GET');
});

test('provider status codes map to stable, explainable error codes', async () => {
  const cases = [
    [401, 'auth'],
    [403, 'auth'],
    [404, 'model_not_found'],
    [429, 'rate_limited'],
    [400, 'provider_error'],
    [500, 'provider_error'],
    [503, 'provider_error'],
  ];
  for (const [status, expected] of cases) {
    const { client } = clientWith(() => jsonResponse(status, { error: { message: 'nope' } }));
    const result = await client.chat({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(result.ok, false, `HTTP ${status} fails`);
    assert.equal(result.error.code, expected, `HTTP ${status} → ${expected}`);
    // Every code has actionable, human-readable text.
    assert.ok(result.error.message.length > 10);
  }
});

test('a provider error that echoes the key is redacted before it can be shown', async () => {
  const { client } = clientWith(() => jsonResponse(401, `{"error":"invalid key: ${KEY}"}`));
  const result = await client.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(result.ok, false);
  assert.ok(!JSON.stringify(result).includes(KEY), 'key never survives (detail included)');
  assert.match(result.error.detail, /redacted/);
});

test('network and timeout failures are distinguished and never throw', async () => {
  const network = createNvidiaChatClient({
    config: { apiKey: KEY, model: MODEL, baseUrl: 'https://x/v1', localOnly: false },
    fetchImpl: async () => { throw new TypeError('fetch failed'); },
  });
  const netResult = await network.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(netResult.error.code, 'network');

  const timeout = createNvidiaChatClient({
    config: { apiKey: KEY, model: MODEL, baseUrl: 'https://x/v1', localOnly: false },
    fetchImpl: async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; },
  });
  const timeoutResult = await timeout.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(timeoutResult.error.code, 'timeout');
});

test('an empty or unparseable completion is an honest empty_reply, not a made-up answer', async () => {
  const empty = clientWith(() => jsonResponse(200, { choices: [{ message: { content: '   ' } }] }));
  assert.equal((await empty.client.chat({ messages: [{ role: 'user', content: 'hi' }] })).error.code, 'empty_reply');

  const junk = clientWith(() => jsonResponse(200, 'not json at all'));
  assert.equal((await junk.client.chat({ messages: [{ role: 'user', content: 'hi' }] })).error.code, 'empty_reply');
});

test('an unconfigured client never reaches the network at all', async () => {
  let called = false;
  const client = createNvidiaChatClient({
    config: { apiKey: null, model: null, baseUrl: 'https://x/v1', localOnly: false },
    fetchImpl: async () => { called = true; return jsonResponse(200, {}); },
  });
  assert.equal(client.configured, false);
  const result = await client.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(result.error.code, 'not_configured');
  assert.equal(called, false, 'no request left the machine');
  assert.equal((await client.listModels()).error.code, 'not_configured');
  assert.equal(called, false);
});

test('every chat error code has a human message', () => {
  for (const [code, message] of Object.entries(CHAT_ERROR_MESSAGES)) {
    assert.equal(typeof code, 'string');
    assert.ok(message.length > 15, `${code} message is actionable`);
  }
});

test('redactSecrets removes bearer headers, labelled values, and raw tokens', () => {
  const samples = [
    `Authorization: Bearer ${KEY}`,
    `api_key=${KEY}`,
    `"apiKey": "${KEY}"`,
    `token: ${KEY}`,
    `secret = ${KEY}`,
    `invalid ${KEY} supplied`,
  ];
  for (const sample of samples) {
    const out = redactSecrets(sample);
    assert.ok(!out.includes(KEY), `token removed from: ${sample}`);
    assert.match(out, /redacted/i);
  }
  assert.equal(redactSecrets('plain text, nothing secret'), 'plain text, nothing secret');
  assert.equal(redactSecrets(null), '');
});

test('redactSecrets blanks an exact secret even when its shape is unusual', () => {
  const odd = 'short-but-exact-value';
  const out = redactSecrets(`the key is ${odd} ok`, { secrets: [odd] });
  assert.ok(!out.includes(odd));
});

test('containsSecretLike detects token-shaped text but ignores normal prose', () => {
  assert.equal(containsSecretLike(`Bearer ${KEY}`), true);
  assert.equal(containsSecretLike(`apiKey=${KEY}`), true);
  assert.equal(containsSecretLike('play Madira on the speakers'), false);
  assert.equal(containsSecretLike(null), false);
});
