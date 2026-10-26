import type {AgentEvent, InputMessage, PendingRequest, SessionCheckpoint, SessionState, SubmissionReceipt} from '../../contracts/agent.js';
import type {JournalEntry} from '../storage.js';

export class ViewModel {
  checkpoint?: SessionCheckpoint;
  state: SessionState = 'opening';
  readonly pending = new Map<string, PendingRequest>();
  readonly receipts = new Map<string, SubmissionReceipt>();
  readonly messages: {role: string; text: string; itemId?: string}[] = [];
  usage: {inputTokens?: number; outputTokens?: number; costUsdEstimate?: number} = {};
  note(text: string, role = 'system'): void {
    this.messages.push({role, text: text.slice(-100_000)});
    if (this.messages.length > 400) this.messages.shift();
  }
  input(input: InputMessage): void {this.note(input.text, input.mode === 'steer-current-turn' ? 'you (steer)' : 'you'); this.receipt({requestId: input.requestId, status: 'queued'});}
  receipt(receipt: SubmissionReceipt): void {this.receipts.set(receipt.requestId, receipt);}
  event(event: AgentEvent, replay = false): void {
    const p = event.payload;
    if (p.type === 'session.ready') this.checkpoint = p.checkpoint;
    else if (p.type === 'state.changed') this.state = p.current;
    else if (p.type === 'submission.changed') this.receipt(p.receipt);
    else if (p.type === 'message.delta') {
      const last = this.messages.at(-1);
      if (last?.role === 'assistant' && last.itemId === p.itemId) last.text = (last.text + p.text).slice(-100_000);
      else {this.note(p.text, 'assistant'); this.messages.at(-1)!.itemId = p.itemId;}
    } else if (p.type === 'tool.started') this.note(`${p.name}\n${JSON.stringify(p.input, null, 2)}`, 'tool');
    else if (p.type === 'tool.completed') this.note(`${p.itemId}: ${p.success ? 'done' : 'failed'}`, 'tool');
    else if (p.type === 'turn.completed') this.note(`turn ${p.outcome}`);
    else if (p.type === 'request.pending' && !replay) this.pending.set(p.request.requestId, p.request);
    else if (p.type === 'request.resolved') this.pending.delete(p.requestId);
    else if (p.type === 'usage.updated') this.usage = {inputTokens: p.inputTokens ?? this.usage.inputTokens, outputTokens: p.outputTokens ?? this.usage.outputTokens, costUsdEstimate: p.costUsdEstimate ?? this.usage.costUsdEstimate};
    else if (p.type === 'adapter.error') this.note(p.message, 'error');
    else if (p.type === 'transport.disconnected') {this.pending.clear(); this.note(`${p.reason}\nRestart with --resume; no input is resent.`, 'disconnected');}
  }
  replay(entries: Iterable<JournalEntry>): void {
    for (const entry of entries) {
      if (entry.kind === 'checkpoint') this.checkpoint = entry.data as SessionCheckpoint;
      else if (entry.kind === 'input') this.input(entry.data as InputMessage);
      else if (entry.kind === 'receipt') this.receipt(entry.data as SubmissionReceipt);
      else if (entry.kind === 'event') this.event(entry.data as AgentEvent, true);
    }
    // Old request IDs belong to dead connection epochs and cannot be answered.
    this.pending.clear(); this.state = 'opening';
  }
}
