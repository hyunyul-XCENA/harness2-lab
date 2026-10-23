// Deterministic App Server fixture: no credentials, model calls or shell execution.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
if (process.argv.includes('--version')) {console.log('codex-cli 0.163.0'); process.exit(0);}
const saved = path.join(process.cwd(), 'fake-history.json');
let thread = fs.existsSync(saved) ? JSON.parse(fs.readFileSync(saved, 'utf8')) : {id: 'native-thread', turns: [], memory: ''};
let active, timer, pendingApproval, pendingQuestion;
const save = () => fs.writeFileSync(saved, JSON.stringify(thread));
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const response = (id, result) => send({id, result});
const event = (method, params) => send({method, params: {threadId: thread.id, ...params}});
const finish = (text, status = 'completed') => {
  if (!active) return;
  clearTimeout(timer);
  const turn = active; active = undefined; turn.status = status;
  if (text) event('item/agentMessage/delta', {itemId: 'message', turnId: turn.id, delta: text});
  save(); event('turn/completed', {turn});
};
readline.createInterface({input: process.stdin}).on('line', line => {
  const m = JSON.parse(line), p = m.params ?? {};
  if (!m.method) {
    if (pendingApproval && m.id === pendingApproval) {pendingApproval = undefined; finish(m.result?.decision === 'accept' ? 'approved' : 'denied');}
    if (pendingQuestion && m.id === pendingQuestion) {pendingQuestion = undefined; finish(m.result?.answers?.language?.answers?.[0] ?? 'question-error');}
    return;
  }
  if (m.method === 'initialize') {response(m.id, {serverInfo: 'fixture'}); return;}
  if (m.method === 'thread/start' || m.method === 'thread/resume') {response(m.id, {thread, model: p.model ?? 'fixture-model'}); return;}
  if (m.method === 'thread/read') {response(m.id, {thread}); return;}
  if (m.method === 'turn/interrupt') {if (!active) {send({id: m.id, error: {code: -32600, message: 'no active turn to interrupt'}}); return;} response(m.id, {}); finish('', 'interrupted'); return;}
  if (m.method === 'turn/steer') {response(m.id, {turnId: active.id}); finish('steered'); return;}
  if (m.method !== 'turn/start') return;
  const text = p.input[0].text;
  if (text === 'reject') {send({id: m.id, error: {code: -32602, message: 'rejected input'}}); return;}
  active = {id: `turn-${thread.turns.length + 1}`, status: 'inProgress', items: []};
  thread.turns.push(active); save();
  const turn = active;
  if (text === 'delayed-start') {
    active = undefined; response(m.id, {turn});
    setTimeout(() => {active = turn; event('turn/started', {turn}); timer = setTimeout(() => finish('late'), 2000);}, 100); return;
  }
  if (text === 'response-first') response(m.id, {turn});
  event('turn/started', {turn});
  if (text === 'disconnect') {process.exit(3);}
  if (text === 'timeout') return;
  if (text !== 'late-response' && text !== 'response-first') response(m.id, {turn});
  if (text === 'approval') {pendingApproval = 'approval-1'; send({id: pendingApproval, method: 'item/commandExecution/requestApproval', params: {threadId: thread.id, turnId: turn.id, itemId: 'tool', command: 'echo fixture'}}); return;}
  if (text === 'question') {pendingQuestion = 'question-1'; send({id: pendingQuestion, method: 'item/tool/requestUserInput', params: {threadId: thread.id, turnId: turn.id, itemId: 'tool', questions: [{id: 'language', question: 'Which language?', isOther: false, options: [{label: 'Korean', description: '한국어'}, {label: 'English', description: 'English'}]}]}}); return;}
  if (text === 'long') {timer = setTimeout(() => finish('long done'), 2000); return;}
  if (text.startsWith('remember ')) thread.memory = text.slice(9);
  const output = text === 'recall' ? thread.memory : text === 'unicode' ? '한글🙂' : `reply:${text}`;
  if (text === 'late-response') {finish(output); setTimeout(() => response(m.id, {turn}), 40);}
  else if (text === 'unicode') {
    const bytes = Buffer.from(JSON.stringify({method: 'item/agentMessage/delta', params: {threadId: thread.id, itemId: 'message', turnId: turn.id, delta: output}}) + '\n');
    let offset = 0;
    timer = setInterval(() => {process.stdout.write(bytes.subarray(offset, ++offset)); if (offset === bytes.length) {clearInterval(timer); finish('');}}, 1);
  } else timer = setTimeout(() => finish(output), 30);
});
