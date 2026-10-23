import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CodexAdapter} from '../src/adapters/codex.js';
import {StateStore} from '../src/storage.js';
import {SessionManager} from '../src/session.js';
import {compileHarness, createSpec, initializeHome, loadConfig, mergeConfig} from '../src/config.js';
import {id} from '../src/util.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = path.join(root, 'test/fixtures/fake-codex.mjs');
function setup() {
  const base = path.join(root, '.test-artifacts', id()); fs.mkdirSync(base, {recursive: true});
  const project = path.join(base, '프로젝트 space'), home = path.join(base, 'home'); fs.mkdirSync(project);
  initializeHome(home); const loaded = loadConfig(project, home);
  const spec = createSpec(loaded.config, compileHarness(loaded.config, home), id());
  const adapter = () => new CodexAdapter({command: process.execPath, prefixArgs: [fixture], timeoutMs: 1000, approvalTimeoutMs: 1000});
  const store = new StateStore(loaded.stateDirectory); store.acquire();
  return {base, project, home, loaded, spec, adapter, store};
}
async function until(predicate: () => boolean, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {if (Date.now() > deadline) throw new Error('Condition timed out'); await new Promise(resolve => setTimeout(resolve, 10));}
}

test('two turns preserve context, process close and resume preserve native thread', async () => {
  const s = setup(); let manager = new SessionManager(s.adapter(), s.store);
  const deltas: string[] = []; manager.on('event', e => {if (e.payload.type === 'message.delta') deltas.push(e.payload.text);});
  try {
    await manager.start(s.spec); await manager.input('remember unique-token'); await until(() => manager.state === 'idle');
    await manager.input('recall'); await until(() => manager.state === 'idle');
    assert.equal(deltas.at(-1), 'unique-token'); assert.equal(s.store.inputs(s.spec.appSessionId).filter(i => i.status === 'completed').length, 2);
    await manager.close();
    manager = new SessionManager(s.adapter(), s.store); manager.on('event', e => {if (e.payload.type === 'message.delta') deltas.push(e.payload.text);});
    await manager.resume(s.spec.appSessionId, s.project); await manager.input('recall'); await until(() => manager.state === 'idle');
    assert.equal(deltas.at(-1), 'unique-token'); assert.equal(s.store.checkpoint(s.spec.appSessionId).nativeSessionId, 'native-thread');
  } finally {await manager.close(); s.store.close();}
});

test('one-message queue, interruption and steering keep the session open', async () => {
  const s = setup(), manager = new SessionManager(s.adapter(), s.store);
  try {
    await manager.start(s.spec); await manager.input('long'); await until(() => !!manager.activeTurn);
    await manager.input('queued'); await assert.rejects(manager.input('overflow'), /queue is full/);
    await manager.interrupt(); await until(() => manager.state === 'idle' && manager.history().length === 2 && manager.history()[1]?.status === 'completed');
    await manager.input('long'); await until(() => !!manager.activeTurn); await manager.input('guidance', true); await until(() => manager.state === 'idle');
    assert.equal(manager.history().length, 4); assert.ok(manager.history().every(i => i.status === 'completed'));
  } finally {await manager.close(); s.store.close();}
});

test('completed notifications arriving before the RPC response never regress receipts', async () => {
  const s = setup(), manager = new SessionManager(s.adapter(), s.store);
  try {await manager.start(s.spec); await manager.input('late-response'); await until(() => manager.state === 'idle'); assert.equal(manager.history()[0]?.status, 'completed'); await manager.input('response-first'); await until(() => manager.state === 'idle'); assert.equal(manager.history()[1]?.status, 'completed');}
  finally {await manager.close(); s.store.close();}
});

test('interrupt waits for a turn accepted before the native started notification', async () => {
  const s = setup(), manager = new SessionManager(s.adapter(), s.store); let outcome = '';
  manager.on('event', event => {if (event.payload.type === 'turn.completed') outcome = event.payload.outcome;});
  try {await manager.start(s.spec); await manager.input('delayed-start'); await manager.interrupt(); await until(() => manager.state === 'idle'); assert.equal(outcome, 'interrupted');}
  finally {await manager.close(); s.store.close();}
});

test('approval is explicit; stale answers fail; rejection does not close session', async () => {
  const s = setup(), manager = new SessionManager(s.adapter(), s.store);
  try {
    await manager.start(s.spec); await manager.input('approval'); await until(() => manager.pending.size === 1);
    await assert.rejects(manager.input('extra'), /pending request/);
    const request = [...manager.pending.keys()][0]!; await manager.answer(request, {kind: 'approval', decision: 'deny'}); await until(() => manager.state === 'idle');
    await assert.rejects(manager.answer(request, {kind: 'approval', decision: 'allow-once'}), /expired|changed/);
    await manager.input('reject'); assert.equal(manager.history().at(-1)?.status, 'rejected'); assert.equal(manager.state, 'idle');
  } finally {await manager.close(); s.store.close();}
});

test('disconnect after acceptance becomes unknown and is never silently resent', async () => {
  const s = setup(), manager = new SessionManager(s.adapter(), s.store);
  try {await manager.start(s.spec); await manager.input('disconnect'); await until(() => manager.state === 'failed'); assert.equal(manager.activeTurn, undefined); assert.equal(manager.history()[0]?.status, 'unknown'); await assert.rejects(manager.input('retry'), /ready session/); assert.equal(JSON.parse(fs.readFileSync(path.join(s.project, 'fake-history.json'), 'utf8')).turns.length, 1);}
  finally {await manager.close(); s.store.close();}
});

test('question answers are validated and UTF-8 survives byte-sized protocol chunks', async () => {
  const s = setup(), manager = new SessionManager(s.adapter(), s.store); let output = '';
  manager.on('event', event => {if (event.payload.type === 'message.delta') output += event.payload.text;});
  try {
    await manager.start(s.spec); await manager.input('question'); await until(() => manager.pending.size === 1);
    const request = [...manager.pending.keys()][0]!;
    await assert.rejects(manager.answer(request, {kind: 'question', answers: {language: 'Invalid'}}), /Invalid answer/);
    await manager.answer(request, {kind: 'question', answers: {language: 'Korean'}}); await until(() => manager.state === 'idle'); assert.equal(output, 'Korean');
    output = ''; await manager.input('unicode'); await until(() => manager.state === 'idle'); assert.equal(output, '한글🙂');
  } finally {await manager.close(); s.store.close();}
});

test('closing during a pending RPC settles delivery before releasing the store', async () => {
  const s = setup(), manager = new SessionManager(s.adapter(), s.store);
  await manager.start(s.spec); const submission = manager.input('timeout');
  await until(() => !!manager.activeTurn); await manager.close(); await submission;
  assert.equal(manager.history()[0]?.status, 'unknown'); s.store.close();
});

test('approval timeout declines once and keeps later turns usable', async () => {
  const s = setup(), manager = new SessionManager(s.adapter(), s.store);
  try {await manager.start(s.spec); await manager.input('approval'); await until(() => manager.pending.size === 1); await until(() => manager.state === 'idle'); assert.equal(manager.pending.size, 0); await manager.input('next'); await until(() => manager.state === 'idle');}
  finally {await manager.close(); s.store.close();}
});

test('sent fence is durable before the adapter can write native bytes', async () => {
  const s = setup(), adapter = s.adapter(), manager = new SessionManager(adapter, s.store);
  const nativeSubmit = adapter.submit.bind(adapter); let observed = '';
  adapter.submit = async (session, input) => {observed = s.store.inputs(session.appSessionId).find(i => i.requestId === input.requestId)!.status; return nativeSubmit(session, input);};
  try {await manager.start(s.spec); await manager.input('fence'); await until(() => manager.state === 'idle'); assert.equal(observed, 'sent');}
  finally {await manager.close(); s.store.close();}
});

test('known failed turn keeps transport usable without acknowledging unknown delivery', async () => {
  const s = setup(), manager = new SessionManager(s.adapter(), s.store); let outcome = '';
  manager.on('event', event => {if (event.payload.type === 'turn.completed') outcome = event.payload.outcome;});
  try {await manager.start(s.spec); await manager.input('failed-turn'); await until(() => manager.state === 'idle'); assert.equal(outcome, 'failed'); assert.equal(manager.history()[0]?.status, 'completed'); await manager.input('after-failure'); await until(() => manager.state === 'idle'); assert.equal(manager.history()[1]?.status, 'completed');}
  finally {await manager.close(); s.store.close();}
});

test('secret question receives an error response while the session stays usable', async () => {
  const s = setup(), manager = new SessionManager(s.adapter(), s.store); let text = '';
  manager.on('event', event => {if (event.payload.type === 'message.delta') text += event.payload.text;});
  try {await manager.start(s.spec); await manager.input('secret'); await until(() => manager.state === 'idle'); assert.equal(text, 'secret-declined'); assert.equal(manager.pending.size, 0); await manager.input('after-secret'); await until(() => manager.state === 'idle'); assert.ok(manager.history().every(i => i.status === 'completed'));}
  finally {await manager.close(); s.store.close();}
});

test('file-change approval includes file paths and diff from the native tool item', async () => {
  const s = setup(), manager = new SessionManager(s.adapter(), s.store);
  try {
    await manager.start(s.spec); await manager.input('file-approval'); await until(() => manager.pending.size === 1);
    const request = [...manager.pending.values()][0]!; assert.equal(request.kind, 'approval');
    if (request.kind !== 'approval') throw new Error('Expected approval');
    assert.match(JSON.stringify(request.input), /example\.txt/); assert.match(JSON.stringify(request.input), /-old/);
    await manager.answer(request.requestId, {kind: 'approval', decision: 'deny'}); await until(() => manager.state === 'idle');
  } finally {await manager.close(); s.store.close();}
});

test('RPC timeout records unknown delivery and terminates its transport', async () => {
  const s = setup(), manager = new SessionManager(s.adapter(), s.store);
  try {await manager.start(s.spec); await manager.input('timeout'); await until(() => manager.state === 'failed', 4000); assert.equal(manager.history()[0]?.status, 'unknown');}
  finally {await manager.close(); s.store.close();}
});

test('config precedence, engine-specific reset and immutable instruction snapshots', () => {
  const s = setup();
  try {
    fs.writeFileSync(path.join(s.home, 'defaults.json'), JSON.stringify({runtime: {model: 'common'}}));
    fs.writeFileSync(path.join(s.loaded.stateDirectory, 'runner.config.json'), JSON.stringify({runtime: {model: 'local'}}));
    assert.equal(loadConfig(s.project, s.home).config.runtime.model, 'local');
    assert.equal(loadConfig(s.project, s.home, {runtime: {model: null}}).config.runtime.model, null);
    const merged = mergeConfig({runtime: {engine: 'claude', model: 'old', claude: {settingsSources: ['user']}}}, {runtime: {engine: 'codex'}});
    assert.deepEqual(merged.runtime, {engine: 'codex'});
    const first = compileHarness(s.loaded.config, s.home); assert.equal(compileHarness(s.loaded.config, s.home).digest, first.digest);
    fs.appendFileSync(path.join(s.home, 'harnesses/coding-v1/instructions.md'), '\nnew instruction');
    assert.notEqual(compileHarness(s.loaded.config, s.home).digest, first.digest);
    assert.equal(JSON.parse(fs.readFileSync(path.join(first.materializedDirectory, 'bundle.json'), 'utf8')).digest, first.digest);
  } finally {s.store.close();}
});

test('project lease excludes a second writer and journal recovers a partial last record', () => {
  const s = setup(), other = new StateStore(s.loaded.stateDirectory);
  try {assert.throws(() => other.acquire(), /active runner/); assert.deepEqual(other.list(), []);} finally {other.close();}
  s.store.append(s.spec.appSessionId, 'checkpoint', {spec: s.spec, runtime: {engine: 'codex', executableVersion: '0.163.0'}, nativeSessionId: 'native', lastJournalSequence: 0});
  s.store.append(s.spec.appSessionId, 'input', {requestId: 'delivery', text: 'safe', mode: 'next-turn'});
  s.store.append(s.spec.appSessionId, 'receipt', {requestId: 'delivery', status: 'sent'}); s.store.close();
  const journal = path.join(s.loaded.stateDirectory, 'sessions', s.spec.appSessionId, 'events.jsonl'); fs.appendFileSync(journal, '{"broken":');
  const recovered = new StateStore(s.loaded.stateDirectory);
  try {recovered.acquire(); assert.equal(recovered.inputs(s.spec.appSessionId)[0]?.status, 'unknown'); assert.ok(fs.readFileSync(journal, 'utf8').endsWith('\n')); assert.ok(fs.readdirSync(path.dirname(journal)).some(name => name.includes('.partial-')));}
  finally {recovered.close();}
});

test('harness rejects Windows path escape and unsupported executable files', () => {
  const s = setup();
  try {
    const manifest = path.join(s.home, 'harnesses/coding-v1/manifest.json');
    fs.writeFileSync(manifest, JSON.stringify({schemaVersion: 1, id: 'coding-v1', parent: null, files: [{path: '..\\escape.md', kind: 'instructions'}]}));
    assert.throws(() => compileHarness(s.loaded.config, s.home), /Invalid harness/);
  } finally {s.store.close();}
});
