import {EventEmitter} from 'node:events';
import type {AgentAdapter, AgentEvent, Capabilities, InputMessage, LiveSession, PendingRequest, RequestAnswer, SessionSpec, SessionState, SubmissionReceipt} from '../contracts/agent.js';
import {StateStore} from './storage.js';
import {errorText, id} from './util.js';

/** One live conversation and one queued input. Every outbound input is journaled first. */
export class SessionManager extends EventEmitter {
  state: SessionState = 'opening';
  activeTurn?: string;
  readonly pending = new Map<string, PendingRequest>();
  private live?: LiveSession;
  private queued?: InputMessage;
  private delivering = false;
  private delivery?: Promise<void>;
  private pump?: Promise<void>;
  private closing = false;
  private closeWork?: Promise<void>;
  private uncertain = false;
  private receipts = new Map<string, SubmissionReceipt>();
  private capabilities?: Capabilities;
  constructor(readonly adapter: AgentAdapter, readonly store: StateStore) {super();}
  private transition(current: SessionState): void {
    if (current === this.state) return;
    const previous = this.state; this.state = current;
    if (this.live) this.persist({eventId: id(), appSessionId: this.live.appSessionId, connectionEpoch: this.live.connectionEpoch, receivedAt: new Date().toISOString(), payload: {type: 'state.changed', previous, current}});
  }
  private persist(event: AgentEvent): void {this.store.append(event.appSessionId, 'event', event); this.emit('event', event);}
  private saveReceipt(receipt: SubmissionReceipt): void {
    const old = this.receipts.get(receipt.requestId);
    if (old?.status === 'completed' || old?.status === 'rejected') return;
    if (old?.status === 'accepted' && ['queued', 'sent'].includes(receipt.status)) return;
    if (old?.status === 'unknown' && ['queued', 'sent', 'accepted'].includes(receipt.status)) return;
    if (old?.status === receipt.status && old.nativeTurnId === receipt.nativeTurnId) return;
    this.receipts.set(receipt.requestId, receipt); this.store.append(this.live!.appSessionId, 'receipt', receipt);
    this.emit('receipt', receipt);
    if (receipt.status === 'unknown') this.uncertain = true;
    if (receipt.status === 'completed' && ![...this.receipts.values()].some(value => value.status === 'unknown')) this.uncertain = false;
  }
  private async saveCheckpoint(): Promise<void> {
    const checkpoint = await this.adapter.checkpoint(this.live!);
    this.store.append(this.live!.appSessionId, 'checkpoint', checkpoint);
    this.emit('checkpoint', checkpoint);
  }
  async start(spec: SessionSpec): Promise<void> {
    this.live = await this.adapter.start(spec);
    if (this.closing) {await this.adapter.close(this.live); throw new Error('Session closed during startup');}
    await this.saveCheckpoint();
    this.transition('idle'); this.listen();
  }
  async resume(sessionId: string, expectedCwd: string): Promise<void> {
    const checkpoint = this.store.checkpoint(sessionId);
    if (checkpoint.spec.cwd !== expectedCwd) throw new Error('Checkpoint belongs to another project');
    if (checkpoint.runtime.engine !== this.adapter.engine) throw new Error('Checkpoint engine does not match adapter');
    const previous = this.store.inputs(sessionId);
    const unknown = previous.filter(input => ['sent', 'accepted', 'unknown'].includes(input.status));
    this.live = await this.adapter.resume(checkpoint);
    if (this.closing) {await this.adapter.close(this.live); throw new Error('Session closed during startup');}
    for (const receipt of await this.adapter.reconcile(this.live, unknown.map(input => ({requestId: input.requestId, status: 'unknown', nativeTurnId: input.nativeTurnId})))) this.saveReceipt(receipt);
    // Queued inputs were never sent; show them in history, do not run on resume.
    for (const input of previous.filter(input => input.status === 'queued')) this.saveReceipt({requestId: input.requestId, status: 'rejected', evidence: 'Unsent input cancelled on resume'});
    await this.saveCheckpoint();
    this.transition('idle'); this.listen();
  }
  private listen(): void {
    const live = this.live!;
    this.pump = (async () => {
      try {
        for await (const event of this.adapter.events(live)) {
          this.persist(event);
          const payload = event.payload;
          if (payload.type === 'session.ready') this.capabilities = payload.capabilities;
          if (payload.type === 'submission.changed') this.saveReceipt(payload.receipt);
          if (payload.type === 'turn.started') {this.activeTurn = payload.nativeTurnId; this.transition(this.pending.size ? 'waiting_request' : 'running');}
          if (payload.type === 'request.pending') {this.pending.set(payload.request.requestId, payload.request); this.transition('waiting_request');}
          if (payload.type === 'request.resolved') {this.pending.delete(payload.requestId); if (this.activeTurn && !this.pending.size) this.transition('running');}
          if (payload.type === 'turn.completed') {
            if (this.activeTurn === payload.nativeTurnId) this.activeTurn = undefined;
            await this.saveCheckpoint();
            if (this.state !== 'failed') {this.transition('idle'); void this.flush();}
          }
          if (payload.type === 'transport.disconnected') {this.uncertain ||= payload.uncertainRequestIds.length > 0; this.activeTurn = undefined; this.pending.clear(); this.transition('failed');}
          if (payload.type === 'adapter.error' && !payload.recoverable) this.transition('failed');
        }
      } catch (error) {this.state = 'failed'; this.emit('failure', errorText(error)); void this.adapter.close(live);}
    })();
  }
  async input(text: string, steer = false): Promise<string> {
    if (!this.live || ['failed', 'closed', 'opening', 'recovering'].includes(this.state)) throw new Error('No ready session');
    if (this.uncertain) throw new Error('An earlier delivery is unknown. Review history and use /ack-unknown before sending more input');
    if (!text.trim()) throw new Error('Empty input');
    if (this.pending.size) throw new Error('Answer the pending request first');
    if (steer && this.capabilities?.midTurnInput !== 'steer') throw new Error('This runtime supports queued follow-ups; /steer is not supported');
    if (steer && (!this.activeTurn || this.delivering)) throw new Error('Steer requires an active turn with no submission in progress');
    if (!steer && this.queued) throw new Error('The one-message queue is full');
    const input: InputMessage = {requestId: id(), text, mode: steer ? 'steer-current-turn' : 'next-turn', ...(steer ? {expectedNativeTurnId: this.activeTurn} : {})};
    this.store.append(this.live.appSessionId, 'input', input);
    this.emit('input', input);
    if (!steer && (this.activeTurn || this.delivering || this.state !== 'idle')) {this.queued = input; return input.requestId;}
    await this.deliver(input); return input.requestId;
  }
  acknowledgeUnknown(): void {this.uncertain = false;}
  private async deliver(input: InputMessage): Promise<void> {
    const task = this.performDelivery(input); this.delivery = task;
    try {await task;} finally {if (this.delivery === task) this.delivery = undefined;}
  }
  private async performDelivery(input: InputMessage): Promise<void> {
    this.delivering = true;
    if (input.mode === 'next-turn') this.transition('running');
    try {
      // Arm recovery durably before adapter.submit can write any native bytes.
      // A crash after this fence is conservatively unknown, even if no bytes left.
      this.saveReceipt({requestId: input.requestId, status: 'sent', evidence: 'Durable pre-send fence; native acceptance is not yet confirmed'});
      const receipt = await this.adapter.submit(this.live!, input); this.saveReceipt(receipt);
      const effective = this.receipts.get(input.requestId)!;
      if (effective.status === 'accepted' && effective.nativeTurnId && this.state !== 'failed' && !this.closing) {
        this.activeTurn = effective.nativeTurnId;
        this.transition(this.pending.size ? 'waiting_request' : 'running');
      }
      if (effective.status === 'unknown') this.transition('failed');
      if (effective.status === 'rejected' && !this.activeTurn && this.state !== 'failed' && !this.closing) this.transition('idle');
    } catch (error) {
      this.saveReceipt({requestId: input.requestId, status: 'unknown', evidence: errorText(error)}); this.transition('failed'); throw error;
    } finally {this.delivering = false; void this.flush();}
  }
  private async flush(): Promise<void> {
    if (!this.queued || this.delivering || this.activeTurn || this.pending.size || this.uncertain || this.state !== 'idle' || this.closing) return;
    const input = this.queued; this.queued = undefined;
    try {await this.deliver(input);} catch (error) {this.emit('failure', errorText(error));}
  }
  async interrupt(): Promise<void> {
    if (!this.live || !this.activeTurn) throw new Error('No active turn to interrupt');
    const previous = this.state; this.transition('interrupting');
    try {await this.adapter.interrupt(this.live, this.activeTurn);} catch (error) {if (this.activeTurn) this.transition(previous); throw error;}
  }
  async answer(requestId: string, answer: RequestAnswer): Promise<void> {
    if (!this.live) throw new Error('No session');
    this.store.append(this.live.appSessionId, 'answer', {requestId, answer, delivery: 'attempt'});
    await this.adapter.answer(this.live, requestId, answer);
    this.store.append(this.live.appSessionId, 'answer', {requestId, answer, delivery: 'sent'});
  }
  history() {return this.live ? this.store.inputs(this.live.appSessionId) : [];}
  close(): Promise<void> {
    return this.closeWork ??= (async () => {
      this.closing = true;
      if (this.queued) {this.saveReceipt({requestId: this.queued.requestId, status: 'rejected', evidence: 'Unsent queued input cancelled on close'}); this.queued = undefined;}
      if (this.live) {await this.adapter.close(this.live); await this.delivery?.catch(() => {}); await this.pump; this.transition('closed');}
    })();
  }
}
