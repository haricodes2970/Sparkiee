import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FOLLOW_UP_MS,
  LONG_GREETING,
  SESSION_GAP_MS,
  conversationDecision,
  isClosingPhrase,
  nextGreeting,
} from '../packages/core/src/conversation.mjs';

test('the first greeting is the full introduction', () => {
  const greeting = nextGreeting({ previousTurn: 0, lastAt: 0, now: 1_000 });
  assert.equal(greeting.mode, 'long');
  assert.equal(greeting.text, LONG_GREETING);
  assert.equal(greeting.turn, 1);
});

test('later greetings in the same session are short and rotate', () => {
  const second = nextGreeting({ previousTurn: 1, lastAt: 10_000, now: 12_000 });
  assert.equal(second.mode, 'short');
  assert.equal(second.turn, 2);
  assert.notEqual(second.text, LONG_GREETING);
  const third = nextGreeting({ previousTurn: 2, lastAt: 12_000, now: 14_000 });
  assert.equal(third.mode, 'short');
  assert.notEqual(third.text, second.text);
});

test('a long idle gap resets the greeting to the full introduction', () => {
  const greeting = nextGreeting({
    previousTurn: 4,
    lastAt: 1_000,
    now: 1_000 + SESSION_GAP_MS + 1,
  });
  assert.equal(greeting.mode, 'long');
  assert.equal(greeting.turn, 1);
});

test('closing phrases end the conversation without matching music stop', () => {
  for (const phrase of ["that's all", 'thanks!', 'Thank you, Sparky.', 'bye', 'see you', 'never mind', 'we are done']) {
    assert.equal(isClosingPhrase(phrase), true, phrase);
  }
  for (const phrase of ['stop', 'pause the music', 'play Madira', 'open project DJ', '']) {
    assert.equal(isClosingPhrase(phrase), false, phrase);
  }
});

test('conversation decisions are honest about silence and closure', () => {
  assert.deepEqual(conversationDecision({ transcript: null }), { continue: false, reason: 'no-speech' });
  assert.deepEqual(conversationDecision({ transcript: '  ' }), { continue: false, reason: 'no-speech' });
  assert.deepEqual(conversationDecision({ transcript: "that's all" }), { continue: false, reason: 'closing' });
  assert.deepEqual(conversationDecision({ transcript: 'open project DJ' }), { continue: true, reason: 'follow-up' });
  assert.equal(FOLLOW_UP_MS >= 5_000, true);
});
