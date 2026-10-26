import test from 'node:test';
import assert from 'node:assert/strict';
import {command} from '../src/commands.js';
import type {SessionManager} from '../src/session.js';

test('runner :: commands stay separate from native slash commands and prompt submission', async () => {
  const calls: unknown[] = [], notes: string[] = [];
  const manager = {input: async (...args: unknown[]) => {calls.push(['input', ...args]);}, interrupt: async () => {calls.push(['interrupt']);}, answer: async (...args: unknown[]) => {calls.push(['answer', ...args]);}, history: () => [], acknowledgeUnknown: () => {calls.push(['ack']);}} as unknown as SessionManager;
  const context = {manager, note: (s: string) => {notes.push(s);}, quit: async () => {calls.push(['quit']);}, sessions: async () => {calls.push(['sessions']);}};
  await command('::help', context); assert.match(notes[0]!, /::interrupt/);
  await command('::interrupt', context); await command('::allow r1', context);
  await command('::deny r2', context); await command('::answer r3 {"q1":"Korean"}', context);
  await command('::steer focus', context); await command('::sessions', context); await command('::quit', context);
  await command('write a small change', context);
  assert.deepEqual(calls, [['interrupt'], ['answer', 'r1', {kind: 'approval', decision: 'allow-once'}], ['answer', 'r2', {kind: 'approval', decision: 'deny'}], ['answer', 'r3', {kind: 'question', answers: {q1: 'Korean'}}], ['input', 'focus', true], ['sessions'], ['quit'], ['input', 'write a small change', false]]);
  const count = calls.length;
  for (const native of ['/status', '/permissions', '/help', '/quit']) await assert.rejects(command(native, context), /native Codex\/Claude CLI UI/);
  await assert.rejects(command('::missing', context), /Unknown runner command/);
  assert.equal(calls.length, count);
});
