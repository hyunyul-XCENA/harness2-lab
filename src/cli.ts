#!/usr/bin/env node
import path from 'node:path';
import readline from 'node:readline';
import {parseArgs} from 'node:util';
import type {AgentEvent} from '../contracts/agent.js';
import {compileHarness, createSpec, initializeHome, loadConfig} from './config.js';
import {StateStore} from './storage.js';
import {CodexAdapter} from './adapters/codex.js';
import {ClaudeAdapter} from './adapters/claude.js';
import {SessionManager} from './session.js';
import {errorText, id, record} from './util.js';

const help = `Terminal Runner 0.2 — persistent Codex / Claude sessions
Usage: npm start -- --project <directory> [--engine codex|claude] [--home <directory>] [--model <model>] [--resume <session-id>]
Options: --codex-path <executable>, --claude-path <executable>, --sessions, --help
Commands:
  /interrupt                 interrupt the current turn (Ctrl+C also works)
  /steer <message>            add guidance to the active Codex turn
  /allow <request-id>         approve once
  /deny <request-id>          deny approval
  /answer <request-id> <JSON> answer questions, e.g. {"language":"Korean"}
  /history                   show input delivery states
  /ack-unknown               acknowledge unknown delivery; never resends it
  /quit                      close the runner, preserving the native thread
Normal input starts a turn. During a turn, one message can be queued.
Claude follow-ups queue until the current turn ends. Full-screen TUI and improvement experiments are later milestones.`;

async function main(): Promise<void> {
  const {values} = parseArgs({options: {project: {type: 'string', default: process.cwd()}, engine: {type: 'string'}, home: {type: 'string'}, model: {type: 'string'}, resume: {type: 'string'}, 'codex-path': {type: 'string'}, 'claude-path': {type: 'string'}, sessions: {type: 'boolean'}, help: {type: 'boolean'}}});
  if (values.help) {console.log(help); return;}
  const runtime = {...(values.engine ? {engine: values.engine} : {}), ...(values.model ? {model: values.model} : {})};
  const {config, home, stateDirectory} = loadConfig(path.resolve(values.project!), values.home, Object.keys(runtime).length ? {runtime} : {});
  if (config.improvement.enabled) throw new Error('Improvement experiments are not implemented yet; set improvement.enabled=false');
  const store = new StateStore(stateDirectory);
  let manager: SessionManager | undefined;
  let rl: readline.Interface | undefined;
  let shutdown: Promise<void> | undefined;
  const close = (): Promise<void> => shutdown ??= (async () => {rl?.close(); try {await manager?.close();} finally {store.close();}})();
  try {
    if (values.sessions) {console.table(store.list()); return;}
    store.acquire();
    initializeHome(home);
    const saved = values.resume ? store.checkpoint(values.resume) : undefined;
    if (saved && values.model) throw new Error('Resume pins the saved model; start a new session to change it');
    if (saved && values.engine && values.engine !== saved.runtime.engine) throw new Error('Resume pins the saved engine; start a new session to switch engines');
    const engine = saved?.runtime.engine ?? config.runtime.engine;
    const adapter = engine === 'claude' ? new ClaudeAdapter({command: values['claude-path'], timeoutMs: config.runtime.startupTimeoutMs}) : new CodexAdapter({command: values['codex-path'], timeoutMs: config.runtime.startupTimeoutMs});
    manager = new SessionManager(adapter, store);
    let streaming = false;
    const line = (text: string) => {if (streaming) {process.stdout.write('\n'); streaming = false;} console.log(text);};
    // Strip terminal escape/control sequences from model and tool output.
    const clean = (text: string) => text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f\x80-\x9f]/g, '');
    manager.on('event', (event: AgentEvent) => {
      const p = event.payload;
      if (p.type === 'message.delta') {process.stdout.write(clean(p.text)); streaming = true;}
      if (p.type === 'session.ready') line(`[session ${event.appSessionId}] ${p.checkpoint.runtime.engine} ${p.checkpoint.runtime.executableVersion} / ${p.checkpoint.resolvedModel ?? p.checkpoint.spec.model ?? 'native default (resolved on first turn)'}`);
      if (p.type === 'turn.completed') {line(`[turn ${p.outcome}]`); rl?.prompt();}
      if (p.type === 'tool.started') line(`[tool ${p.name}] ${clean(JSON.stringify(p.input))}`);
      if (p.type === 'request.pending') {
        line(`[${p.request.kind} ${p.request.requestId}] ${p.request.kind === 'approval' ? clean(p.request.description) : clean(JSON.stringify(p.request.questions))}`);
        if (p.request.kind === 'approval') line(clean(JSON.stringify(p.request.input, null, 2)));
        rl?.prompt();
      }
      if (p.type === 'submission.changed' && ['unknown', 'rejected'].includes(p.receipt.status)) line(`[${p.receipt.status}] ${clean(p.receipt.evidence ?? '')}`);
      if (p.type === 'transport.disconnected') line(`[disconnected] ${clean(p.reason)} — restart with --resume; no input is resent`);
      if (p.type === 'adapter.error') line(`[error] ${clean(p.message)}`);
    });
    manager.on('failure', (message: string) => line(`[failed] ${clean(message)}`));
    if (values.resume) await manager.resume(values.resume, config.project.path);
    else await manager.start(createSpec(config, compileHarness(config, home), id()));
    line('Ready. /help for commands.');
    rl = readline.createInterface({input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY, prompt: '> '});
    let commandChain = Promise.resolve();
    rl.on('line', (input: string) => {
      commandChain = commandChain.then(async () => {
        const text = input.trim(); if (!text || shutdown) return;
        const [command, ...rest] = text.split(' '), args = rest.join(' ').trim();
        if (command === '/quit') {await close(); return;}
        if (command === '/help') line(help);
        else if (command === '/interrupt') await manager!.interrupt();
        else if (command === '/steer') void manager!.input(args, true).catch(error => line(`[error] ${clean(errorText(error))}`));
        else if (command === '/allow' || command === '/deny') await manager!.answer(args, {kind: 'approval', decision: command === '/allow' ? 'allow-once' : 'deny'});
        else if (command === '/answer') {
          const space = args.indexOf(' '); if (space < 0) throw new Error('/answer <request-id> {"question-id":"answer"}');
          const answers = record(JSON.parse(args.slice(space + 1)));
          if (Object.values(answers).some(value => typeof value !== 'string')) throw new Error('Each answer must be a string');
          await manager!.answer(args.slice(0, space), {kind: 'question', answers: answers as Record<string, string>});
        } else if (command === '/history') console.table(manager!.history().map(({requestId, text, status, nativeTurnId}) => ({requestId, text: clean(text.slice(0, 100)), status, nativeTurnId})));
        else if (command === '/ack-unknown') {manager!.acknowledgeUnknown(); line('Acknowledged. Previous input was not resent.');}
        else if (command?.startsWith('/')) throw new Error('Unknown command; use /help');
        else void manager!.input(text).catch(error => line(`[error] ${clean(errorText(error))}`));
        if (!shutdown) rl?.prompt();
      }).catch(error => {line(`[error] ${clean(errorText(error))}`); rl?.prompt();});
    });
    const signal = () => {if (manager?.activeTurn && manager.state !== 'failed') void manager.interrupt().catch(error => line(errorText(error))); else void close();};
    rl.on('SIGINT', signal); process.on('SIGINT', signal); process.once('SIGTERM', () => {void close();});
    rl.prompt();
    await new Promise<void>(resolve => rl!.once('close', resolve));
    await commandChain;
  } finally {await close();}
}
main().catch(error => {console.error(errorText(error)); process.exitCode = 1;});
