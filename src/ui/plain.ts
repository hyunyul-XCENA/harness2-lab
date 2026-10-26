import readline from 'node:readline';
import type {AgentEvent} from '../../contracts/agent.js';
import type {SessionManager} from '../session.js';
import {command} from '../commands.js';
import {errorText} from '../util.js';
import {clean} from './terminal.js';

export class PlainApp {
  closeError?: unknown;
  private rl?: readline.Interface;
  private streaming = false;
  private closing = false;
  private chain = Promise.resolve();
  private done: () => void = () => {};
  readonly finished = new Promise<void>(resolve => {this.done = resolve;});
  private onEvent = (event: AgentEvent) => {
    const p = event.payload;
    if (p.type === 'message.delta') {process.stdout.write(clean(p.text)); this.streaming = true;}
    if (p.type === 'session.ready') this.note(`[session ${event.appSessionId}] ${p.checkpoint.runtime.engine} ${p.checkpoint.runtime.executableVersion} / ${p.checkpoint.resolvedModel ?? p.checkpoint.spec.model ?? 'native default (resolved on first turn)'}`);
    if (p.type === 'turn.completed') {this.note(`[turn ${p.outcome}]`); this.rl?.prompt();}
    if (p.type === 'tool.started') this.note(`[tool ${p.name}] ${JSON.stringify(p.input)}`);
    if (p.type === 'request.pending') {
      this.note(`[${p.request.kind} ${p.request.requestId}] ${p.request.kind === 'approval' ? p.request.description : JSON.stringify(p.request.questions)}`);
      if (p.request.kind === 'approval') this.note(JSON.stringify(p.request.input, null, 2));
      this.rl?.prompt();
    }
    if (p.type === 'submission.changed' && ['unknown', 'rejected'].includes(p.receipt.status)) this.note(`[${p.receipt.status}] ${p.receipt.evidence ?? ''}`);
    if (p.type === 'transport.disconnected') this.note(`[disconnected] ${p.reason} — restart with --resume; no input is resent`);
    if (p.type === 'adapter.error') this.note(`[error] ${p.message}`);
  };
  private onFailure = (message: string) => this.note(`[failed] ${message}`);
  private signal = () => {
    if (this.manager.activeTurn && this.manager.state !== 'failed') void this.manager.interrupt().catch(error => this.note(errorText(error)));
    else void this.finish();
  };
  private terminate = () => {void this.finish();};
  constructor(private manager: SessionManager) {manager.on('event', this.onEvent); manager.on('failure', this.onFailure);}
  note(text: string): void {if (this.streaming) {process.stdout.write('\n'); this.streaming = false;} console.log(clean(text));}
  ready(): void {
    this.note('Ready. /help for commands.');
    this.rl = readline.createInterface({input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY, prompt: '> '});
    this.rl.on('line', (input: string) => {
      this.chain = this.chain.then(async () => {
        if (this.closing) return;
        await command(input, {manager: this.manager, note: text => this.note(text), quit: () => this.finish(), sessions: async () => this.note(this.manager.store.list().map(row => `${row.id} ${row.state} ${row.updated}`).join('\n') + '\nRestart with --resume <id> or --select (interactive terminal).')});
        if (!this.closing) this.rl?.prompt();
      }).catch(error => {this.note(`[error] ${errorText(error)}`); if (!this.closing) this.rl?.prompt();});
    });
    this.rl.on('SIGINT', this.signal); process.on('SIGINT', this.signal); process.once('SIGTERM', this.terminate);
    this.rl.once('close', () => {void this.chain.finally(() => this.finish());}); this.rl.prompt();
  }
  async finish(): Promise<void> {
    if (this.closing) return; this.closing = true; this.rl?.close();
    try {await this.manager.close();} catch (error) {this.closeError = error;} finally {this.dispose(); this.done();}
  }
  dispose(): void {
    this.manager.removeListener('event', this.onEvent); this.manager.removeListener('failure', this.onFailure);
    process.removeListener('SIGINT', this.signal); process.removeListener('SIGTERM', this.terminate);
  }
}
