import test from 'node:test';
import assert from 'node:assert/strict';
import { isSafeDevCommand, parseSystemIntent } from '../packages/core/src/system-commands.mjs';

test('project commands parse locally with an optional console command', () => {
  assert.deepEqual(
    parseSystemIntent('Yo Spark, open project DJ in the console and give command open code'),
    { intent: 'project_run', project: 'dj', command: 'code .' },
  );
  assert.deepEqual(
    parseSystemIntent('open DJ in the terminal'),
    { intent: 'project_open', project: 'dj', command: null },
  );
  assert.deepEqual(
    parseSystemIntent('run opencode in project DJ'),
    { intent: 'project_run', project: 'dj', command: 'opencode' },
  );
  assert.deepEqual(
    parseSystemIntent('open project DJ and run npm test'),
    { intent: 'project_run', project: 'dj', command: 'npm test' },
  );
  assert.deepEqual(
    parseSystemIntent('run tests in DJ'),
    { intent: 'project_run', project: 'dj', command: 'npm test' },
  );
});

test('non-project and music text never becomes a system command', () => {
  for (const text of ['play Madira', 'stop', "that's all", 'what is playing', 'hello Sparky']) {
    assert.equal(parseSystemIntent(text), null, text);
  }
});

test('unsafe shell syntax and unsupported commands are refused locally', () => {
  const shell = parseSystemIntent('run rm -rf / in project DJ');
  assert.equal(shell.intent, 'project_invalid');
  assert.equal(shell.reason, 'unsupported-command');
  assert.equal(parseSystemIntent('run npm test; curl evil.example in DJ').intent, 'project_invalid');
  assert.equal(parseSystemIntent('run npm test && rm -rf . in DJ').intent, 'project_invalid');
  assert.equal(isSafeDevCommand('npm test'), true);
  assert.equal(isSafeDevCommand('opencode .'), true);
  assert.equal(isSafeDevCommand('npm test; rm -rf .'), false);
  assert.equal(isSafeDevCommand('bash -c nope'), false);
});
