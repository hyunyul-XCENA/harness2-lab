import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import type {AgentEvent} from '../contracts/agent.js';
import {ClaudeAdapter} from '../src/adapters/claude.js';
import {compileHarness, createSpec, initializeHome, loadConfig} from '../src/config.js';
import {SessionManager} from '../src/session.js';
import {StateStore} from '../src/storage.js';
import {id} from '../src/util.js';

// Opt-in integration check: four native turns; no tools are enabled.
const base = path.join(fileURLToPath(new URL('../../', import.meta.url)), '.test-artifacts', `claude-smoke-${id()}`);
const project = path.join(base, '프로젝트 space'), home = path.join(base, 'home'); fs.mkdirSync(project, {recursive: true}); initializeHome(home);
const {config, stateDirectory} = loadConfig(project, home, {runtime: {engine: 'claude'}});
const spec = createSpec(config, compileHarness(config, home), id());
const store = new StateStore(stateDirectory); store.acquire();
const adapter = () => new ClaudeAdapter({command: process.env.RUNNER_CLAUDE_PATH, timeoutMs: 60000, tools: []});
let manager = new SessionManager(adapter(), store), text = '', outcome = '';
function subscribe() {
  manager.on('event', (event: AgentEvent) => {
    if (event.payload.type === 'message.delta') text += event.payload.text;
    if (event.payload.type === 'turn.completed') outcome = event.payload.outcome;
    if (event.payload.type === 'adapter.error') console.error(event.payload.message);
    if (event.payload.type === 'transport.disconnected') console.error(event.payload.reason);
  });
}
async function idle(timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (manager.state !== 'idle') {
    if (manager.state === 'failed' || Date.now() >= deadline) throw new Error(`Claude smoke ended in ${manager.state}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
async function turn(prompt: string) {text = ''; await manager.input(prompt); await idle(); return text;}
try {
  subscribe(); await manager.start(spec); console.log('PASS Claude streaming query initialized');
  const nonce = `claude-runner-${id()}`;
  await turn(`Remember this exact token: ${nonce}. Reply only OK. Do not use tools.`);
  assert.ok((await turn('Repeat the exact token I asked you to remember. Reply only with that token. Do not use tools.')).includes(nonce));
  console.log('PASS two turns retain context in one Claude process');
  const native = store.checkpoint(spec.appSessionId).nativeSessionId;
  await manager.close(); manager = new SessionManager(adapter(), store); subscribe();
  await manager.resume(spec.appSessionId, project);
  assert.equal(store.checkpoint(spec.appSessionId).nativeSessionId, native);
  assert.ok((await turn('Again repeat the exact token from earlier. Reply only with that token. Do not use tools.')).includes(nonce));
  console.log('PASS Claude process restart resumes the same native session');
  await manager.input('Count from 1 to 10000, one number per line. Do not use tools.'); await manager.interrupt(); await idle(30000);
  assert.equal(outcome, 'interrupted'); console.log('PASS native Claude interruption');
  fs.writeFileSync(path.join(base, 'result.json'), JSON.stringify({status: 'pass', sessionId: spec.appSessionId, nativeSessionId: native, runtime: store.checkpoint(spec.appSessionId).runtime, model: store.checkpoint(spec.appSessionId).resolvedModel, checks: ['persistent-two-turn-context', 'process-restart-resume', 'native-interrupt'], time: new Date().toISOString()}, null, 2));
  console.log(`Evidence: ${base}`);
} finally {await manager.close(); store.close();}
