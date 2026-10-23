import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import type {AgentEvent} from '../contracts/agent.js';
import {CodexAdapter} from '../src/adapters/codex.js';
import {compileHarness, createSpec, initializeHome, loadConfig} from '../src/config.js';
import {SessionManager} from '../src/session.js';
import {StateStore} from '../src/storage.js';
import {id} from '../src/util.js';

// Explicit opt-in: this script uses the installed Codex login and starts four turns.
const base = path.join(fileURLToPath(new URL('../../', import.meta.url)), '.test-artifacts', `smoke-${id()}`);
const project = path.join(base, 'project'), home = path.join(base, 'home'); fs.mkdirSync(project, {recursive: true}); initializeHome(home);
const {config, stateDirectory} = loadConfig(project, home);
const spec = createSpec(config, compileHarness(config, home), id());
const store = new StateStore(stateDirectory); store.acquire();
const adapter = () => new CodexAdapter({command: process.env.RUNNER_CODEX_PATH, sandbox: 'read-only', timeoutMs: 60000});
let manager = new SessionManager(adapter(), store), text = '', outcome = '';
function subscribe() {
  manager.on('event', (event: AgentEvent) => {
    if (event.payload.type === 'message.delta') text += event.payload.text;
    if (event.payload.type === 'turn.completed') outcome = event.payload.outcome;
    if (event.payload.type === 'adapter.error') console.error(event.payload.message);
    if (event.payload.type === 'request.pending' && event.payload.request.kind === 'approval') void manager.answer(event.payload.request.requestId, {kind: 'approval', decision: 'deny'});
  });
}
async function turn(prompt: string): Promise<string> {
  text = ''; await manager.input(prompt);
  const deadline = Date.now() + 180000;
  while (manager.state !== 'idle') {
    if (manager.state === 'failed') throw new Error('Session failed');
    if (Date.now() > deadline) throw new Error('Smoke turn timed out');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return text;
}
try {
  subscribe(); await manager.start(spec); console.log('PASS native thread started');
  const nonce = `runner-${id()}`;
  await turn(`This is a conversation continuity test. Remember this exact token: ${nonce}. Reply only OK. Do not use any tools.`);
  assert.ok((await turn('What exact token did I ask you to remember? Reply only with the token. Do not use tools.')).includes(nonce));
  console.log('PASS two turns retain context in one process');
  const native = store.checkpoint(spec.appSessionId).nativeSessionId;
  await manager.close(); manager = new SessionManager(adapter(), store); subscribe();
  await manager.resume(spec.appSessionId, project);
  assert.equal(store.checkpoint(spec.appSessionId).nativeSessionId, native);
  assert.ok((await turn('Repeat the exact token I asked you to remember earlier. Reply only with the token. Do not use tools.')).includes(nonce));
  console.log('PASS process restart resumes the same native conversation');
  await manager.input('Count from 1 to 10000, one number per line. Do not use tools.'); await manager.interrupt();
  const interruptDeadline = Date.now() + 30000;
  while (manager.state !== 'idle') {if (Date.now() > interruptDeadline) throw new Error('Interrupt timed out'); await new Promise(resolve => setTimeout(resolve, 100));}
  assert.equal(outcome, 'interrupted'); console.log('PASS native turn interruption');
  fs.writeFileSync(path.join(base, 'result.json'), JSON.stringify({status: 'pass', sessionId: spec.appSessionId, nativeSessionId: native, model: store.checkpoint(spec.appSessionId).resolvedModel, checks: ['persistent-two-turn-context', 'process-restart-resume', 'native-interrupt'], time: new Date().toISOString()}, null, 2));
  console.log(`Evidence: ${base}`);
} finally {await manager.close(); store.close();}
