import type {AgentEvent, Engine, InputMessage, PendingRequest, RequestAnswer, SubmissionReceipt} from '../../contracts/agent.js';
import type {SessionManager} from '../session.js';
import type {StateStore} from '../storage.js';
import {command} from '../commands.js';
import {errorText} from '../util.js';
import {ViewModel} from './model.js';
import {clip, Editor, Screen, wrap, type Key, type TerminalInput, type TerminalOutput} from './terminal.js';

export type Selection = {engine: Engine; resume?: string};
export function chooseSession(store: StateStore, project: string, input: TerminalInput, output: TerminalOutput, preferred: Engine = 'codex'): Promise<Selection | undefined> {
  const choices: {label: string; detail: string; selection: Selection}[] = ['codex', 'claude'].map(engine => ({label: `New ${engine} conversation`, detail: 'Uses current project settings and harness.', selection: {engine: engine as Engine}}));
  for (const row of store.list()) {
    const saved = store.checkpoint(row.id);
    choices.push({label: `${saved.runtime.engine} | ${row.updated} | ${row.state}`, detail: `${row.id}\n${saved.resolvedModel ?? saved.spec.model ?? 'native default'} | ${saved.spec.harness.scope}:${saved.spec.harness.id}\n${saved.spec.cwd}`, selection: {engine: saved.runtime.engine, resume: row.id}});
  }
  return new Promise(resolve => {
    let index = preferred === 'claude' ? 1 : 0, closed = false;
    const finish = (choice?: Selection) => {if (closed) return; closed = true; process.removeListener('SIGTERM', cancel); process.removeListener('SIGINT', cancel); input.removeListener('end', cancel); screen.close(); resolve(choice);};
    const cancel = () => finish();
    const screen = new Screen(input, output, key => {
      if (['escape', 'interrupt', 'eof'].includes(key.name)) finish();
      else if (screen.rows < 12 || screen.columns < 45) return;
      else if (key.name === 'up') index = Math.max(0, index - 1);
      else if (key.name === 'down') index = Math.min(choices.length - 1, index + 1);
      else if (key.name === 'enter') finish(choices[index]!.selection);
      screen.invalidate();
    }, () => {
      const columns = screen.columns, rows = screen.rows;
      if (rows < 12 || columns < 45) return {lines: ['Terminal Runner: enlarge terminal to 46 x 12.', 'Esc / Ctrl+C: quit']};
      const available = Math.max(1, rows - 10), offset = Math.max(0, Math.min(index - Math.floor(available / 2), choices.length - available));
      const list = choices.slice(offset, offset + available).map((value, i) => `${offset + i === index ? '>' : ' '} ${value.label}`);
      while (list.length < available) list.push('');
      return {lines: ['TERMINAL RUNNER 0.3 | new / resume', clip(project, columns), '─'.repeat(columns), ...list, '─'.repeat(columns), ...choices[index]!.detail.split('\n').slice(0, 3), '', '↑/↓ choose  Enter open  Esc quit']};
    });
    process.once('SIGTERM', cancel); process.once('SIGINT', cancel); input.once('end', cancel);
  });
}

type Review = {request: PendingRequest; choice: number; question: number; answers: Record<string, string>; editor: Editor; typing: boolean};
/** UI never owns native delivery; SessionManager remains the authority. */
export class TuiApp {
  readonly model = new ViewModel();
  readonly editor = new Editor();
  readonly screen: Screen;
  closeError?: unknown;
  private scroll = 0;
  private review?: Review;
  private reviewScroll = 0;
  private busy = false;
  private closing = false;
  private chain = Promise.resolve();
  private done: (action: 'quit' | 'select') => void = () => {};
  readonly finished = new Promise<'quit' | 'select'>(resolve => {this.done = resolve;});
  private onEvent = (event: AgentEvent) => {
    this.model.event(event);
    if (this.review && !this.model.pending.has(this.review.request.requestId)) this.review = undefined;
    this.screen.invalidate();
  };
  private onInput = (input: InputMessage) => {this.model.input(input); this.scroll = 0; this.screen.invalidate();};
  private onReceipt = (receipt: SubmissionReceipt) => {this.model.receipt(receipt); this.screen.invalidate();};
  private onFailure = (message: string) => {this.model.state = 'failed'; this.model.pending.clear(); this.review = undefined; this.note(`[failed] ${message}`);};
  private signal = () => {void this.interruptOrQuit();};
  private terminate = () => {void this.finish('quit');};
  private tick: ReturnType<typeof setInterval>;
  constructor(readonly manager: SessionManager, project: string, engine: Engine, input: TerminalInput, output: TerminalOutput, resume?: string) {
    if (resume) {
      this.model.replay(manager.store.entries(resume));
      // Recovery can change index statuses without rewriting old journal receipts.
      for (const value of manager.store.inputs(resume)) this.model.receipt(value);
      this.model.note(`Restored local transcript for ${resume}. Old requests are closed.`);
    }
    this.screen = new Screen(input, output, key => this.key(key), () => this.frame(project, engine));
    manager.on('event', this.onEvent); manager.on('input', this.onInput); manager.on('receipt', this.onReceipt); manager.on('failure', this.onFailure);
    process.on('SIGINT', this.signal); process.once('SIGTERM', this.terminate); input.once('end', this.terminate);
    this.tick = setInterval(() => {if (this.model.pending.size) this.screen.invalidate();}, 1000);
  }
  note(text: string): void {this.model.note(text); this.scroll = 0; this.screen.invalidate();}
  ready(): void {this.model.state = this.manager.state; this.note('Ready. /help for commands. /sessions opens the conversation picker.');}
  private async interruptOrQuit(): Promise<void> {
    if (this.manager.activeTurn && this.manager.state !== 'failed') {
      try {await this.manager.interrupt();} catch (error) {this.note(errorText(error));}
    } else if (this.manager.state === 'running') this.note('Native turn has not started yet. Retry Ctrl+C, or /quit to close.');
    else await this.finish('quit');
  }
  private enqueue(work: () => Promise<void>): void {
    this.chain = this.chain.then(async () => {if (!this.closing) await work();}).catch(error => this.note(`[error] ${errorText(error)}`));
  }
  private key(key: Key): void {
    if (this.closing) return;
    if (key.name === 'interrupt') {void this.interruptOrQuit(); return;}
    if (key.name === 'eof') {void this.finish('quit'); return;}
    if (this.screen.rows < 12 || this.screen.columns < 45) return;
    if (key.name === 'pageup' || key.name === 'pagedown') {
      const delta = Math.max(1, this.screen.rows - 8) * (key.name === 'pageup' ? 1 : -1);
      if (this.review) this.reviewScroll = Math.max(0, this.reviewScroll + delta); else this.scroll = Math.max(0, this.scroll + delta);
    } else if (key.name === 'f2' && !this.busy) {
      if (this.review) this.review = undefined;
      else {
        const request = this.model.pending.values().next().value;
        if (request) {this.review = {request, choice: 0, question: 0, answers: {}, editor: new Editor(), typing: false}; this.reviewScroll = 0;}
      }
    } else if (this.review) this.reviewKey(key);
    else if (key.name === 'enter') {
      const text = this.editor.take(); this.scroll = 0;
      this.enqueue(() => command(text, {manager: this.manager, note: text => this.note(text), quit: () => this.finish('quit'), sessions: () => this.finish('select')}));
    } else if (key.name === 'escape') this.scroll = 0;
    else this.editor.key(key);
    this.screen.invalidate();
  }
  private reviewKey(key: Key): void {
    const review = this.review!;
    if (key.name === 'escape') {this.review = undefined; return;}
    if (this.busy) return;
    if (!this.manager.pending.has(review.request.requestId) || Date.parse(review.request.expiresAt) <= Date.now()) {this.review = undefined; this.note('Request expired; no answer sent.'); return;}
    if (review.request.kind === 'approval') {
      if (['up', 'down', 'left', 'right', 'tab'].includes(key.name)) review.choice = 1 - review.choice;
      else if (key.name === 'enter') this.sendAnswer(review.request.requestId, {kind: 'approval', decision: review.choice ? 'allow-once' : 'deny'});
    } else {
      const question = review.request.questions[review.question]; if (!question) return;
      const options = [...(question.options ?? []), ...(question.allowFreeText ? ['Type an answer…'] : [])];
      if (review.typing) {
        if (key.name === 'enter') {const answer = review.editor.take().trim(); if (answer) this.nextQuestion(answer);}
        else review.editor.key(key);
      } else if (key.name === 'up') review.choice = Math.max(0, review.choice - 1);
      else if (key.name === 'down' || key.name === 'tab') review.choice = Math.min(options.length - 1, review.choice + 1);
      else if (key.name === 'enter' && options.length) {
        if (review.choice < (question.options?.length ?? 0)) this.nextQuestion(question.options![review.choice]!);
        else review.typing = true;
      }
    }
  }
  private nextQuestion(answer: string): void {
    const review = this.review!; if (review.request.kind !== 'question') return;
    review.answers[review.request.questions[review.question]!.id] = answer;
    if (++review.question === review.request.questions.length) this.sendAnswer(review.request.requestId, {kind: 'question', answers: {...review.answers}});
    else {review.choice = 0; review.typing = false; this.reviewScroll = 0;}
  }
  private sendAnswer(requestId: string, answer: RequestAnswer): void {
    this.busy = true; this.review = undefined;
    this.enqueue(async () => {
      try {await this.manager.answer(requestId, answer); this.note(`Answer sent for ${requestId}.`);}
      finally {this.busy = false; this.screen.invalidate();}
    });
  }
  private frame(project: string, engine: Engine): {lines: string[]; cursor?: {row: number; column: number}} {
    const columns = this.screen.columns, rows = this.screen.rows;
    if (rows < 12 || columns < 45) return {lines: ['Terminal Runner: enlarge terminal to 46 x 12.', 'Ctrl+C interrupt / quit; Ctrl+D quit']};
    const c = this.model.checkpoint, counts = [...this.model.receipts.values()].reduce<Record<string, number>>((out, value) => {out[value.status] = (out[value.status] ?? 0) + 1; return out;}, {});
    const header = [`TERMINAL RUNNER | ${engine} | ${this.closing ? 'closing' : this.model.state} | ${c?.resolvedModel ?? c?.spec.model ?? 'native default'}`, project, `session ${c?.spec.appSessionId ?? 'opening…'} | harness ${c ? `${c.spec.harness.scope}:${c.spec.harness.id} ${c.spec.harness.digest.slice(0, 8)}` : 'loading'}`];
    const bodyHeight = rows - 8;
    let body: string[], footer: string, editor = this.editor;
    if (this.review) {
      const r = this.review, request = r.request;
      const q = request.kind === 'question' ? request.questions[r.question] : undefined;
      const options = q ? [...(q.options ?? []), ...(q.allowFreeText ? ['Type an answer…'] : [])] : [];
      const details = request.kind === 'approval' ? `${request.toolName}\n${request.description}\n${JSON.stringify(request.input, null, 2)}` : `Question ${r.question + 1}/${request.questions.length}\n${q?.text ?? ''}\n\n${options.map((option, i) => `${i === r.choice ? '>' : ' '} ${option}`).join('\n')}`;
      const lines = wrap(`REVIEW ${request.kind} | ${request.requestId}\nExpires ${request.expiresAt}\n${details}`, columns);
      const max = Math.max(0, lines.length - bodyHeight); this.reviewScroll = Math.min(this.reviewScroll, max);
      body = lines.slice(this.reviewScroll, this.reviewScroll + bodyHeight);
      if (request.kind === 'approval') footer = `${r.choice ? '  Deny' : '> Deny'}    ${r.choice ? '> Allow once' : '  Allow once'} | Enter confirm | Esc back | PgUp/PgDn details`;
      else {
        if (r.typing) {editor = r.editor; footer = `Type answer for ${q!.id}. Enter sends / next question; Esc back.`;}
        else footer = `${r.choice + 1}/${options.length} > ${options[r.choice] ?? 'No supported answer'} | ↑/↓ choose, Enter select, Esc back`;
      }
    } else {
      const lines = this.model.messages.flatMap(value => wrap(`[${value.role}] ${value.text}`, columns).concat(''));
      this.scroll = Math.min(this.scroll, Math.max(0, lines.length - bodyHeight));
      const end = Math.max(0, lines.length - this.scroll); body = lines.slice(Math.max(0, end - bodyHeight), end);
      footer = this.model.pending.size ? `${this.model.pending.size} pending request(s) — F2 review; /allow /deny /answer also work` : `queued ${counts.queued ?? 0} | unknown ${counts.unknown ?? 0} | tokens ${this.model.usage.inputTokens ?? '?'} in / ${this.model.usage.outputTokens ?? '?'} out (native totals)${this.scroll ? ' | SCROLLED' : ''}`;
    }
    while (body.length < bodyHeight) body.push('');
    const view = editor.view(Math.max(1, columns - 2));
    const hint = this.closing ? 'Closing native connection…' : this.busy ? 'Sending answer…' : 'Enter send | F2 request | PgUp/PgDn scroll | Ctrl+C interrupt/quit | /help';
    return {lines: [...header, '─'.repeat(columns), ...body, footer, `> ${view.text}`, hint, ''], ...(!this.closing && (!this.review || this.review.typing) ? {cursor: {row: rows - 2, column: view.cursor + 3}} : {})};
  }
  async finish(action: 'quit' | 'select'): Promise<void> {
    if (this.closing) return; this.closing = true; this.screen.invalidate();
    try {await this.manager.close();} catch (error) {this.closeError = error;}
    finally {this.dispose(); this.done(action);}
  }
  dispose(): void {
    clearInterval(this.tick); this.screen.close();
    this.manager.removeListener('event', this.onEvent); this.manager.removeListener('input', this.onInput); this.manager.removeListener('receipt', this.onReceipt); this.manager.removeListener('failure', this.onFailure);
    process.removeListener('SIGINT', this.signal); process.removeListener('SIGTERM', this.terminate); this.screen.input.removeListener('end', this.terminate);
  }
}
