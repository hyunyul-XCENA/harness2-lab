import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {query, getSessionInfo, getSessionMessages} from '@anthropic-ai/claude-agent-sdk';
import {ClaudeAdapter, type ClaudeSdk} from '../src/adapters/claude.js';
import {compileHarness, createSpec, initializeHome, loadConfig} from '../src/config.js';
import {SessionManager} from '../src/session.js';
import {StateStore} from '../src/storage.js';
import {id} from '../src/util.js';
import type {AgentEvent} from '../contracts/agent.js';

// Two real turns: one question and one explicitly approved write, in a disposable project.
const base = path.join(fileURLToPath(new URL('../../', import.meta.url)), '.test-artifacts', `claude-input-${id()}`);
const project = path.join(base, 'project'), home = path.join(base, 'home'); fs.mkdirSync(project, {recursive: true}); initializeHome(home);
const {config, stateDirectory} = loadConfig(project, home, {runtime: {engine: 'claude', claude: {settingsSources: []}}});
const spec = createSpec(config, compileHarness(config, home), id());
const provider: ClaudeSdk = {
  query: params => query({...params, options: {...params.options, settings: {permissions: {ask: ['Write', 'AskUserQuestion']}}}}),
  info: getSessionInfo, messages: getSessionMessages,
};
const store = new StateStore(stateDirectory); store.acquire();
const manager = new SessionManager(new ClaudeAdapter({command: process.env.RUNNER_CLAUDE_PATH, timeoutMs: 60000, tools: ['Write', 'AskUserQuestion']}, provider), store);
const target = path.join(project, 'approved-fixture.txt'), marker = `approved-${id()}`;
let questions = 0, approvals = 0, outcome = '', handlerError: unknown;
manager.on('event', (event: AgentEvent) => {
  const payload = event.payload;
  if (payload.type === 'turn.completed') outcome = payload.outcome;
  if (payload.type === 'adapter.error') console.error(payload.message);
  if (payload.type !== 'request.pending') return;
  const request = payload.request;
  void (async () => {
    if (request.kind === 'question') {
      questions++; const answers = Object.fromEntries(request.questions.map(question => [question.id, question.options?.find(option => option === 'Korean') ?? 'Korean']));
      await manager.answer(request.requestId, {kind: 'question', answers});
    } else {
      assert.equal(request.toolName, 'Write');
      const input = request.input as {file_path: string; content: string};
      assert.equal(path.resolve(input.file_path), target); assert.equal(input.content, marker);
      approvals++; await manager.answer(request.requestId, {kind: 'approval', decision: 'allow-once'});
    }
  })().catch(error => {handlerError = error; void manager.close();});
});
async function turn(text: string) {
  await manager.input(text); const deadline = Date.now() + 180000;
  while (manager.state !== 'idle') {
    if (handlerError) throw handlerError;
    if (manager.state === 'failed' || manager.state === 'closed' || Date.now() >= deadline) throw new Error(`Native input test ended in ${manager.state}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(outcome, 'success');
}
try {
  await manager.start(spec);
  await turn('Use AskUserQuestion exactly once to ask which language to use, with the two options Korean and English. After receiving my answer, reply OK and stop. Do not use Write.');
  assert.equal(questions, 1); console.log('PASS native AskUserQuestion callback and answer');
  await turn(`Use Write exactly once to create ${JSON.stringify(target)} with this exact content and no newline: ${marker}. Do not ask clarifying questions or use any other tools. After it succeeds, reply OK.`);
  assert.equal(approvals, 1); assert.equal(fs.readFileSync(target, 'utf8'), marker); console.log('PASS native Write allow-once callback and exact approved contents');
  fs.writeFileSync(path.join(base, 'result.json'), JSON.stringify({status: 'pass', questions, approvals, model: store.checkpoint(spec.appSessionId).resolvedModel, checks: ['native-question-answer', 'native-write-allow-once'], time: new Date().toISOString()}, null, 2));
  console.log(`Evidence: ${base}`);
} finally {await manager.close(); store.close();}
