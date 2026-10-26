import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {PassThrough} from 'node:stream';
import {spawnSync} from 'node:child_process';
import {ClaudeAdapter} from '../src/adapters/claude.js';
import {StateStore} from '../src/storage.js';
import {SessionManager} from '../src/session.js';
import {compileHarness, createSpec, initializeHome, loadConfig} from '../src/config.js';
import {id} from '../src/util.js';
import {FakeClaudeSdk} from './fake-claude-sdk.js';
import {chooseSession, TuiApp} from '../src/ui/app.js';
import {Editor, KeyDecoder, Screen, clean, width, wrap, type Key, type TerminalInput, type TerminalOutput} from '../src/ui/terminal.js';
import {ViewModel} from '../src/ui/model.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
class Input extends PassThrough {
  isTTY = true;
  isRaw = false;
  setRawMode(value: boolean): this {this.isRaw = value; return this;}
}
class Output extends PassThrough {
  isTTY = true;
  columns = 90;
  rows = 24;
  frames: string[] = [];
  constructor() {super(); this.on('data', data => this.frames.push(String(data)));}
}
function terminal() {const input = new Input(), output = new Output(); return {input, output, stdin: input as unknown as TerminalInput, stdout: output as unknown as TerminalOutput};}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {if (Date.now() > deadline) throw new Error('Condition timed out'); await new Promise(resolve => setTimeout(resolve, 5));}
}
function setup() {
  const base = path.join(root, '.test-artifacts', `tui-${id()}`), project = path.join(base, '한글 project'), home = path.join(base, 'home');
  fs.mkdirSync(project, {recursive: true}); initializeHome(home);
  const loaded = loadConfig(project, home, {runtime: {engine: 'claude'}}), spec = createSpec(loaded.config, compileHarness(loaded.config, home), id());
  const store = new StateStore(loaded.stateDirectory); store.acquire();
  const provider = new FakeClaudeSdk(), adapter = () => new ClaudeAdapter({timeoutMs: 400, approvalTimeoutMs: 4000}, provider);
  const manager = new SessionManager(adapter(), store), t = terminal();
  const app = new TuiApp(manager, project, 'claude', t.stdin, t.stdout);
  return {...t, base, project, store, spec, provider, adapter, manager, app};
}

test('terminal parser keeps UTF-8 and split bracketed paste atomic; pasted commands never submit', () => {
  const keys: Key[] = [], parser = new KeyDecoder(key => keys.push(key));
  const bytes = Buffer.from('한🙂\x1b[200~/quit\n/allow request\x1b[201~');
  for (const byte of bytes) parser.push(Buffer.from([byte]));
  assert.deepEqual(keys, [{name: 'text', text: '한'}, {name: 'text', text: '🙂'}, {name: 'paste', text: '/quit\n/allow request'}]);
  parser.push('\r'); assert.equal(keys.at(-1)?.name, 'enter'); parser.close();
  assert.equal(clean('\x1b]52;c;clipboard\x07\x1b[2Jhello\x00\u202e'), 'hello');
});

test('editor deletes and moves by grapheme; Korean/emoji wrapping and history preserve the draft', () => {
  const editor = new Editor(); editor.key({name: 'paste', text: '가👨‍👩‍👧‍👦e\u0301'});
  editor.key({name: 'backspace'}); assert.equal(editor.text, '가👨‍👩‍👧‍👦');
  editor.key({name: 'left'}); editor.key({name: 'delete'}); assert.equal(editor.text, '가');
  editor.take(); editor.set('draft'); editor.key({name: 'up'}); assert.equal(editor.text, '가'); editor.key({name: 'down'}); assert.equal(editor.text, 'draft');
  for (const line of wrap('한글🙂e\u0301\nnext', 4)) assert.ok(width(line) <= 4);
  editor.set('한글🙂abcdef'); const view = editor.view(8); assert.ok(width(view.text) <= 8); assert.ok(view.cursor < 8);
});

test('screen coalesces paints, handles resize, strips controls, and restores original terminal modes', async () => {
  const t = terminal(); t.input.pause(); let paints = 0;
  const screen = new Screen(t.stdin, t.stdout, () => {}, () => {paints++; return {lines: ['한글🙂\x1b[2J', 'next'], cursor: {row: 2, column: 3}};});
  try {
    for (let i = 0; i < 100; i++) screen.invalidate();
    await until(() => paints === 1); assert.equal(t.input.isRaw, true);
    t.output.columns = 5; t.output.rows = 2; t.output.emit('resize');
    await until(() => paints === 2);
    assert.ok(t.output.frames.at(-1)!.includes('한글')); assert.ok(!t.output.frames.at(-1)!.includes('🙂'));
    assert.ok(!t.output.frames.at(-1)!.includes('\x1b[2J'));
  } finally {screen.close(); screen.close();}
  assert.equal(t.input.isRaw, false); assert.equal(t.input.isPaused(), true); assert.equal(t.input.listenerCount('data'), 0); assert.equal(t.output.listenerCount('resize'), 0);
  assert.ok(t.output.frames.at(-1)!.includes('\x1b[?1049l'));
});

test('TUI preserves draft during streaming, queues one input, and restores transcript on resume', async () => {
  const s = setup();
  try {
    await s.manager.start(s.spec); s.app.ready();
    s.input.write('remember 연속대화🙂\r'); await until(() => s.manager.history()[0]?.status === 'completed');
    s.input.write('long\r'); await until(() => !!s.manager.activeTurn);
    s.input.write('recall\r'); await until(() => s.manager.history().at(-1)?.status === 'queued');
    s.input.write('아직 안 보낼 초안');
    s.input.write('\x03'); await until(() => s.manager.history().length === 3 && s.manager.history().at(-1)?.status === 'completed');
    assert.equal(s.app.editor.text, '아직 안 보낼 초안'); assert.ok(s.app.model.messages.some(value => value.text === '연속대화🙂'));
    assert.equal(s.app.model.receipts.get(s.manager.history().at(-1)!.requestId)?.status, 'completed');
    await s.app.finish('quit');
    const next = new SessionManager(s.adapter(), s.store), t = terminal(), app = new TuiApp(next, s.project, 'claude', t.stdin, t.stdout, s.spec.appSessionId);
    try {
      assert.ok(app.model.messages.some(value => value.text.includes('연속대화🙂'))); assert.equal(app.model.pending.size, 0);
      await next.resume(s.spec.appSessionId, s.project); app.ready();
      t.input.write('recall\r'); await until(() => next.history().at(-1)?.status === 'completed' && next.history().length === 4);
      assert.equal(s.provider.options.length, 2);
    } finally {await app.finish('quit');}
  } finally {await s.app.finish('quit'); s.store.close();}
});

test('approval requires F2 review and explicit selection; default deny and tiny-terminal Enter cannot approve', async () => {
  const s = setup();
  try {
    await s.manager.start(s.spec); s.app.ready(); s.input.write('approval\r'); await until(() => s.manager.pending.size === 1);
    s.input.write('\r'); await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(s.provider.decisions.length, 0);
    s.input.write('\x1bOQ\r'); await until(() => s.provider.decisions.length === 1); assert.equal(s.provider.decisions[0]?.behavior, 'deny');
    await until(() => s.manager.state === 'idle'); s.input.write('approval\r'); await until(() => s.manager.pending.size === 1);
    s.input.write('\x1bOQ\x1b[C'); s.output.rows = 5; s.output.emit('resize'); s.input.write('\r');
    await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(s.provider.decisions.length, 1);
    s.output.rows = 24; s.output.emit('resize'); s.input.write('\r'); await until(() => s.provider.decisions.length === 2);
    assert.equal(s.provider.decisions[1]?.behavior, 'allow'); assert.equal(s.provider.decisions[1]?.behavior === 'allow' && 'updatedPermissions' in s.provider.decisions[1], false);
  } finally {await s.app.finish('quit'); s.store.close();}
});

test('TUI question choices and free text map to native question keys; composer draft survives', async () => {
  const s = setup();
  try {
    await s.manager.start(s.spec); s.app.ready(); s.input.write('question\r'); await until(() => s.manager.pending.size === 1);
    s.input.write('보존할 초안'); s.input.write('\x1bOQ\x1b[B\r'); await until(() => s.provider.decisions.length === 1);
    const decision = s.provider.decisions[0]; assert.equal(decision?.behavior, 'allow');
    if (decision?.behavior === 'allow') assert.deepEqual(decision.updatedInput?.answers, {'Language?': 'English'});
    assert.equal(s.app.editor.text, '보존할 초안'); s.input.write('\x15');
    await until(() => s.manager.state === 'idle'); s.input.write('question\r'); await until(() => s.manager.pending.size === 1);
    s.input.write('\x1bOQ\x1b[B\x1b[B\r'); s.input.write('\x1b[200~한국어\n추가 답변\x1b[201~');
    assert.equal(s.provider.decisions.length, 1); s.input.write('\r'); await until(() => s.provider.decisions.length === 2);
    const free = s.provider.decisions[1]; if (free?.behavior === 'allow') assert.deepEqual(free.updatedInput?.answers, {'Language?': '한국어\n추가 답변'}); else assert.fail('Expected free text answer');
  } finally {await s.app.finish('quit'); s.store.close();}
});

test('session chooser returns the stored engine and session; cancelling releases terminal listeners', async () => {
  const s = setup();
  try {
    await s.manager.start(s.spec); await s.app.finish('quit');
    const t = terminal(), choice = chooseSession(s.store, s.project, t.stdin, t.stdout);
    t.input.write('\x1b[B\x1b[B\r'); assert.deepEqual(await choice, {engine: 'claude', resume: s.spec.appSessionId}); assert.equal(t.input.isRaw, false);
    const cancel = chooseSession(s.store, s.project, t.stdin, t.stdout, 'claude'); t.input.write('\x03'); assert.equal(await cancel, undefined); assert.equal(t.input.listenerCount('data'), 0);
  } finally {await s.app.finish('quit'); s.store.close();}
});

test('closing during native startup closes the late live session; repeated close shares completion', async () => {
  const s = setup(); let release!: () => void;
  const nativeStart = s.manager.adapter.start.bind(s.manager.adapter);
  s.manager.adapter.start = async spec => {await new Promise<void>(resolve => {release = resolve;}); return nativeStart(spec);};
  try {
    const start = s.manager.start(s.spec); const stopped = s.app.finish('quit'); await stopped; release();
    await assert.rejects(start, /closed during startup/); assert.equal(s.provider.closeCount, 1);
    assert.equal(s.input.isRaw, false); assert.equal(s.manager.close(), s.manager.close());
  } finally {await s.app.finish('quit'); s.store.close();}
});

test('native usage totals replace previous values; unsafe terminal escapes never reach rendered content', () => {
  const view = new ViewModel();
  const event = (payload: any) => view.event({eventId: id(), appSessionId: id(), connectionEpoch: id(), receivedAt: '', payload});
  event({type: 'usage.updated', inputTokens: 5, outputTokens: 3}); event({type: 'usage.updated', inputTokens: 8, outputTokens: 6}); assert.equal(view.usage.inputTokens, 8);
  event({type: 'message.delta', itemId: 'a', text: '\x1b]52;c;'}); event({type: 'message.delta', itemId: 'a', text: 'bad\x07visible'});
  assert.equal(wrap(view.messages[0]!.text, 80).join(''), 'visible');
});

test('CLI rejects forced TUI on pipes and retains plain EOF/quit behavior without model calls', () => {
  const cwd = path.join(root, '.test-artifacts', `cli-tui-${id()}`); fs.mkdirSync(cwd, {recursive: true});
  const cli = path.join(root, 'dist/src/cli.js');
  const result = spawnSync(process.execPath, [cli, '--tui', '--project', cwd], {input: '', encoding: 'utf8', windowsHide: true});
  assert.equal(result.status, 1); assert.match(result.stderr, /interactive terminal/); assert.ok(!result.stdout.includes('\x1b[?1049h'));
  const listed = spawnSync(process.execPath, [cli, '--sessions', '--project', cwd, '--home', path.join(cwd, 'home')], {encoding: 'utf8', windowsHide: true});
  assert.equal(listed.status, 0); assert.ok(!listed.stdout.includes('\x1b[?1049h'));
  for (const input of ['/help\n/history\n/quit\n', '']) {
    const plain = spawnSync(process.execPath, [path.join(root, 'dist/test/fixtures/plain-runner.js'), cwd], {input, encoding: 'utf8', windowsHide: true, timeout: 5000});
    assert.equal(plain.status, 0, plain.stderr); assert.match(plain.stdout, /fixture closed 1/); assert.ok(!plain.stdout.includes('\x1b[?1049h'));
  }
});
