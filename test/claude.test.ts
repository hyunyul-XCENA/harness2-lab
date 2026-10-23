import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ClaudeAdapter} from '../src/adapters/claude.js';
import {StateStore} from '../src/storage.js';
import {SessionManager} from '../src/session.js';
import {compileHarness, createSpec, initializeHome, loadConfig} from '../src/config.js';
import {id} from '../src/util.js';
import {FakeClaudeSdk} from './fake-claude-sdk.js';
import type {AgentEvent} from '../contracts/agent.js';

function setup() {
  const base = path.join(fileURLToPath(new URL('../../', import.meta.url)), '.test-artifacts', `claude-${id()}`);
  const project = path.join(base, '프로젝트 space'), home = path.join(base, 'home'); fs.mkdirSync(project, {recursive: true}); initializeHome(home);
  const loaded = loadConfig(project, home, {runtime: {engine: 'claude'}});
  const spec = createSpec(loaded.config, compileHarness(loaded.config, home), id());
  const store = new StateStore(loaded.stateDirectory); store.acquire();
  const provider = new FakeClaudeSdk(), adapter = () => new ClaudeAdapter({timeoutMs: 250, approvalTimeoutMs: 150}, provider);
  return {base, project, home, spec, store, provider, adapter};
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {if (Date.now() > deadline) throw new Error('Condition timed out'); await new Promise(resolve => setTimeout(resolve, 5));}
}

test('Claude keeps one SDK query across turns and resumes the same pinned native session', async () => {
  const s = setup(); let manager = new SessionManager(s.adapter(), s.store), output = '';
  const onEvent = (event: AgentEvent) => {if (event.payload.type === 'message.delta') output += event.payload.text;}; manager.on('event', onEvent);
  try {
    await manager.start(s.spec); assert.equal(s.provider.inputs.length, 0);
    await manager.input('remember token-123'); await until(() => manager.state === 'idle'); output = '';
    await manager.input('recall'); await until(() => manager.state === 'idle'); assert.equal(output, 'token-123'); assert.equal(s.provider.options.length, 1);
    const checkpoint = s.store.checkpoint(s.spec.appSessionId); assert.equal(checkpoint.resolvedModel, 'fixture-model');
    assert.equal(s.provider.options[0]?.permissionMode, 'default'); assert.deepEqual(s.provider.options[0]?.settingSources, ['user', 'project', 'local']);
    await manager.close(); s.spec.harness.appendedInstructions = 'changed source after start';
    manager = new SessionManager(s.adapter(), s.store); manager.on('event', onEvent);
    await manager.resume(s.spec.appSessionId, s.project); output = ''; await manager.input('recall'); await until(() => manager.state === 'idle');
    assert.equal(output, 'token-123'); assert.equal(s.provider.options[1]?.resume, checkpoint.nativeSessionId); assert.equal(s.provider.options[1]?.model, 'fixture-model');
    assert.deepEqual(s.provider.options[1]?.systemPrompt, {type: 'preset', preset: 'claude_code', append: checkpoint.spec.harness.appendedInstructions});
  } finally {await manager.close(); s.store.close();}
});

test('Claude queues one follow-up, rejects steer before journaling and interrupts after native start', async () => {
  const s = setup(), manager = new SessionManager(s.adapter(), s.store);
  try {
    await manager.start(s.spec); await manager.input('delayed');
    await assert.rejects(manager.input('not steering', true), /steer is not supported/); assert.equal(manager.history().length, 1);
    await manager.input('queued'); await assert.rejects(manager.input('overflow'), /queue is full/);
    await manager.interrupt(); await until(() => manager.state === 'idle' && manager.history().at(-1)?.status === 'completed');
    assert.equal(manager.history().length, 2); assert.equal(s.provider.options.length, 1);
  } finally {await manager.close(); s.store.close();}
});

test('Claude approvals are concrete, allow once only, and expired replies fail', async () => {
  const s = setup(), manager = new SessionManager(s.adapter(), s.store);
  try {
    await manager.start(s.spec); await manager.input('approval'); await until(() => manager.pending.size === 1);
    const request = [...manager.pending.values()][0]!; assert.equal(request.kind, 'approval'); assert.match(JSON.stringify(request), /concrete proposed contents/);
    await manager.answer(request.requestId, {kind: 'approval', decision: 'allow-once'}); await until(() => manager.state === 'idle');
    const decision = s.provider.decisions[0]!; assert.equal(decision.behavior, 'allow'); assert.ok(!('updatedPermissions' in decision));
    await assert.rejects(manager.answer(request.requestId, {kind: 'approval', decision: 'allow-once'}), /expired/);
    await manager.input('approval'); await until(() => manager.pending.size === 1); await until(() => manager.state === 'idle'); assert.equal(s.provider.decisions.at(-1)?.behavior, 'deny');
  } finally {await manager.close(); s.store.close();}
});

test('Claude question answers retain native question keys; unsupported multi-select declines locally', async () => {
  const s = setup(), manager = new SessionManager(s.adapter(), s.store);
  try {
    await manager.start(s.spec); await manager.input('question'); await until(() => manager.pending.size === 1);
    const key = [...manager.pending.keys()][0]!; await assert.rejects(manager.answer(key, {kind: 'question', answers: {}}), /Invalid answer/);
    await manager.answer(key, {kind: 'question', answers: {q1: 'Korean'}}); await until(() => manager.state === 'idle');
    const decision = s.provider.decisions[0]!; assert.equal(decision.behavior, 'allow'); if (decision.behavior === 'allow') assert.deepEqual(decision.updatedInput?.answers, {'Language?': 'Korean'});
    await manager.input('multi'); await until(() => manager.state === 'idle'); assert.equal(s.provider.decisions.at(-1)?.behavior, 'deny');
  } finally {await manager.close(); s.store.close();}
});

test('Claude native failed result completes delivery and accepts the next turn without false unknown', async () => {
  const s = setup(), manager = new SessionManager(s.adapter(), s.store); const outcomes: string[] = [];
  manager.on('event', (event: AgentEvent) => {if (event.payload.type === 'turn.completed') outcomes.push(event.payload.outcome);});
  try {await manager.start(s.spec); await manager.input('failed'); await until(() => manager.state === 'idle'); await manager.input('next'); await until(() => manager.state === 'idle'); assert.deepEqual(outcomes, ['failed', 'success']); assert.ok(manager.history().every(input => input.status === 'completed'));}
  finally {await manager.close(); s.store.close();}
});

test('Claude disconnect and lost acknowledgement stay unknown and are never resent on resume', async () => {
  const s = setup(); let manager = new SessionManager(s.adapter(), s.store);
  try {
    await manager.start(s.spec); await manager.input('disconnect'); await until(() => manager.state === 'failed'); assert.equal(manager.history()[0]?.status, 'unknown'); await manager.close();
    manager = new SessionManager(s.adapter(), s.store); await manager.resume(s.spec.appSessionId, s.project);
    assert.equal(s.provider.inputs.length, 1); await assert.rejects(manager.input('new'), /earlier delivery is unknown/);
    manager.acknowledgeUnknown(); await manager.input('new'); await until(() => manager.state === 'idle'); assert.equal(s.provider.inputs.length, 2);
  } finally {await manager.close(); s.store.close();}
});

test('Claude acknowledgement timeout closes the stream and conservatively records unknown', async () => {
  const s = setup(), manager = new SessionManager(s.adapter(), s.store);
  try {await manager.start(s.spec); await manager.input('timeout'); await until(() => manager.state === 'failed'); assert.equal(manager.history()[0]?.status, 'unknown'); assert.equal(s.provider.inputs.length, 1);}
  finally {await manager.close(); s.store.close();}
});

test('Claude version drift and missing transcript refuse resume without opening a query', async () => {
  const s = setup(), adapter = s.adapter();
  try {
    const live = await adapter.start(s.spec), checkpoint = await adapter.checkpoint(live); await adapter.close(live);
    s.provider.inspectedVersion = 'different'; await assert.rejects(s.adapter().resume(checkpoint), /Supported Claude/);
    s.provider.inspectedVersion = '2.1.309'; s.provider.histories.clear(); await assert.rejects(s.adapter().resume(checkpoint), /transcript was not found/);
    assert.equal(s.provider.options.length, 1);
  } finally {s.store.close();}
});

test('Claude reconciliation does not mistake model end_turn for an outer SDK result', async () => {
  const s = setup(), adapter = s.adapter();
  try {
    const live = await adapter.start(s.spec); const requestId = id();
    s.provider.histories.set(live.nativeSessionId, [
      {type: 'user', uuid: requestId, session_id: live.nativeSessionId, parent_tool_use_id: null, parent_agent_id: null, message: {content: 'same text'}},
      {type: 'assistant', uuid: id(), session_id: live.nativeSessionId, parent_tool_use_id: null, parent_agent_id: null, message: {stop_reason: 'end_turn'}},
    ]);
    const result = await adapter.reconcile(live, [{requestId, status: 'unknown'}, {requestId: id(), status: 'unknown'}]);
    assert.deepEqual(result.map(receipt => receipt.status), ['unknown', 'unknown']); assert.match(result[0]!.evidence!, /UUID is recorded/); assert.equal(s.provider.inputs.length, 0); await adapter.close(live);
  } finally {s.store.close();}
});

test('Claude model drift closes safely and repeated close settles once', async () => {
  const s = setup(), manager = new SessionManager(s.adapter(), s.store);
  try {
    await manager.start(s.spec); await manager.input('first'); await until(() => manager.state === 'idle'); s.provider.overrideModel = 'unexpected-model';
    await manager.input('second'); await until(() => manager.state === 'failed'); await Promise.all([manager.close(), manager.close()]); assert.equal(s.provider.closeCount, 1);
  } finally {await manager.close(); s.store.close();}
});

test('late accepted receipts cannot revive completed or disconnected Claude turns', async () => {
  for (const text of ['first', 'disconnect']) {
    const s = setup(), adapter = s.adapter(), manager = new SessionManager(adapter, s.store);
    const submit = adapter.submit.bind(adapter);
    adapter.submit = async (session, input) => {const receipt = await submit(session, input); await new Promise(resolve => setTimeout(resolve, 60)); return receipt;};
    try {
      await manager.start(s.spec); await manager.input(text);
      assert.equal(manager.state, text === 'disconnect' ? 'failed' : 'idle'); assert.equal(manager.activeTurn, undefined);
      assert.equal(manager.history()[0]?.status, text === 'disconnect' ? 'unknown' : 'completed');
    } finally {await manager.close(); s.store.close();}
  }
});
