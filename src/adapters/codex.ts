import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type {AgentAdapter, AgentEvent, Capabilities, EventPayload, InputMessage, Json, LiveSession, PendingRequest, RequestAnswer, RuntimeIdentity, SessionCheckpoint, SessionSpec, SubmissionReceipt} from '../../contracts/agent.js';
import type {InitializeParams} from './codex-protocol/InitializeParams.js';
import type {ThreadStartParams} from './codex-protocol/v2/ThreadStartParams.js';
import type {ThreadResumeParams} from './codex-protocol/v2/ThreadResumeParams.js';
import type {TurnStartParams} from './codex-protocol/v2/TurnStartParams.js';
import type {TurnSteerParams} from './codex-protocol/v2/TurnSteerParams.js';
import {AsyncQueue, errorText, id, record, string} from '../util.js';
import {ConnectionError, JsonRpcProcess, RpcError, type RpcMessage} from './rpc.js';

export const CODEX_VERSION = '0.163.0';
const capabilities: Capabilities = {persistentInput: true, resume: true, interrupt: true, midTurnInput: 'steer', approvalRequests: true, userQuestions: true, hardCostLimit: false, hardTokenLimit: false};
export interface CodexOptions {command?: string; prefixArgs?: string[]; timeoutMs?: number; approvalTimeoutMs?: number; sandbox?: 'read-only' | 'workspace-write'; env?: NodeJS.ProcessEnv}
type NativeRequest = {id: string | number; request: PendingRequest; timer: NodeJS.Timeout};

/** Pinned stdio App Server adapter. The native thread owns conversation history. */
export class CodexAdapter implements AgentAdapter {
  readonly engine = 'codex' as const;
  private rpc?: JsonRpcProcess;
  private live?: LiveSession;
  private saved?: SessionCheckpoint;
  private queue = new AsyncQueue<AgentEvent>();
  private subscribed = false;
  private closing = false;
  private submissions = new Map<string, SubmissionReceipt>();
  private requests = new Map<string, NativeRequest>();
  private sending?: InputMessage;
  private activeTurn?: string;
  private completedTurns = new Set<string>();
  private startedTurns = new Set<string>();
  private fileChanges = new Map<string, Json>();
  constructor(private options: CodexOptions = {}) {}
  private get command(): string {return this.options.command ?? (process.platform === 'win32' ? 'codex.exe' : 'codex');}
  async inspect(): Promise<{runtime: RuntimeIdentity; capabilities: Capabilities}> {
    const {stdout} = await promisify(execFile)(this.command, [...this.options.prefixArgs ?? [], '--version'], {windowsHide: true, timeout: this.options.timeoutMs ?? 15000, env: this.options.env});
    const version = /codex-cli (\S+)/.exec(stdout)?.[1];
    if (version !== CODEX_VERSION) throw new Error(`Supported Codex version: ${CODEX_VERSION}; installed: ${version ?? stdout.trim()}`);
    return {runtime: {engine: 'codex', executableVersion: version, protocolVersion: `app-server-${CODEX_VERSION}`}, capabilities};
  }
  private check(session: LiveSession): void {
    if (!this.live || session.connectionEpoch !== this.live.connectionEpoch || session.appSessionId !== this.live.appSessionId) throw new Error('Stale or unknown connection');
  }
  private emit(payload: EventPayload): void {
    if (!this.live) return;
    try {this.queue.push({eventId: id(), appSessionId: this.live.appSessionId, connectionEpoch: this.live.connectionEpoch, receivedAt: new Date().toISOString(), payload});}
    catch (error) {this.queue.end(new Error(`Event consumer fell behind: ${errorText(error)}`)); void this.rpc?.close().catch(() => {});}
  }
  private receipt(receipt: SubmissionReceipt): SubmissionReceipt {
    const old = this.submissions.get(receipt.requestId);
    if (old?.status === 'completed' || old?.status === 'rejected') return old;
    this.submissions.set(receipt.requestId, receipt);
    this.emit({type: 'submission.changed', receipt});
    return receipt;
  }
  private async open(spec: SessionSpec, previous?: SessionCheckpoint): Promise<LiveSession> {
    if (this.rpc) throw new Error('Use a fresh adapter for each connection');
    if (spec.claude) throw new Error('Claude options cannot be used with Codex');
    const {runtime} = await this.inspect();
    if (previous && JSON.stringify(previous.runtime) !== JSON.stringify(runtime)) throw new Error('Runtime version changed; resume requires the original Codex version');
    this.live = {appSessionId: spec.appSessionId, nativeSessionId: previous?.nativeSessionId ?? '', connectionEpoch: id()};
    const rpc = this.rpc = new JsonRpcProcess({command: this.command, args: [...this.options.prefixArgs ?? [], 'app-server', '--listen', 'stdio://'], cwd: spec.cwd, timeoutMs: this.options.timeoutMs, env: this.options.env});
    rpc.on('message', (message: RpcMessage) => {
      try { this.message(message); }
      catch (error) { this.emit({type: 'adapter.error', code: 'PROTOCOL_EVENT', message: errorText(error), recoverable: false}); void rpc.close(); }
    });
    rpc.on('disconnected', (error: Error) => {
      for (const pending of this.requests.values()) clearTimeout(pending.timer);
      this.requests.clear();
      if (!this.closing) {
        const uncertain: string[] = [];
        for (const receipt of this.submissions.values()) if (['sent', 'accepted'].includes(receipt.status)) {
          uncertain.push(receipt.requestId); this.receipt({...receipt, status: 'unknown', evidence: 'Transport disconnected; no automatic resend'});
        }
        this.emit({type: 'transport.disconnected', uncertainRequestIds: uncertain, reason: error.message});
      }
      this.queue.end();
    });
    try {
      const initialize: InitializeParams = {clientInfo: {name: 'terminal_runner', title: 'Harness² Lab', version: '0.1.0'}, capabilities: {experimentalApi: true, requestAttestation: false}};
      await rpc.call('initialize', initialize); rpc.send({method: 'initialized'});
      const common = {cwd: spec.cwd, ...(previous?.resolvedModel ?? spec.model ? {model: previous?.resolvedModel ?? spec.model} : {}), developerInstructions: spec.harness.appendedInstructions, approvalPolicy: 'on-request' as const, sandbox: this.options.sandbox ?? 'workspace-write' as const};
      const params: ThreadStartParams | ThreadResumeParams = previous ? {...common, threadId: previous.nativeSessionId} : common;
      const response = record(await rpc.call(previous ? 'thread/resume' : 'thread/start', params));
      const thread = record(response.thread);
      this.live.nativeSessionId = string(thread.id, 'thread.id');
      const model = string(response.model, 'model');
      if (previous?.resolvedModel && model !== previous.resolvedModel) throw new Error('Resolved model changed while resuming');
      this.saved = {spec, runtime, nativeSessionId: this.live.nativeSessionId, resolvedModel: model, lastJournalSequence: previous?.lastJournalSequence ?? 0, ...(previous?.lastNativeTurnId ? {lastNativeTurnId: previous.lastNativeTurnId} : {})};
      // Never start another turn if a resumed native conversation is still running.
      if (previous && Array.isArray(thread.turns) && thread.turns.some(turn => record(turn).status === 'inProgress')) throw new Error('Native turn is still running; wait for it to finish before reconnecting');
      this.emit({type: 'session.ready', capabilities, checkpoint: structuredClone(this.saved)});
      return {...this.live};
    } catch (error) { this.closing = true; await rpc.close(); throw error; }
  }
  start(spec: SessionSpec): Promise<LiveSession> {return this.open(spec);}
  resume(checkpoint: SessionCheckpoint): Promise<LiveSession> {return this.open(checkpoint.spec, checkpoint);}
  events(session: LiveSession): AsyncIterable<AgentEvent> {
    this.check(session); if (this.subscribed) throw new Error('Events already subscribed'); this.subscribed = true; return this.queue;
  }
  async submit(session: LiveSession, input: InputMessage): Promise<SubmissionReceipt> {
    this.check(session);
    if (!input.text.trim()) throw new Error('Empty input');
    if (this.submissions.has(input.requestId)) throw new Error('Duplicate request ID');
    if (this.sending) throw new Error('Another submission is being delivered');
    if (input.mode === 'next-turn' && this.activeTurn) throw new Error('A turn is already running');
    if (input.mode === 'steer-current-turn' && (!this.activeTurn || input.expectedNativeTurnId !== this.activeTurn)) throw new Error('Steer requires the current native turn ID');
    this.sending = input;
    this.receipt({requestId: input.requestId, status: 'sent'});
    try {
      const text = [{type: 'text' as const, text: input.text, text_elements: []}];
      const params: TurnStartParams | TurnSteerParams = input.mode === 'next-turn'
        ? {threadId: session.nativeSessionId, clientUserMessageId: input.requestId, input: text}
        : {threadId: session.nativeSessionId, clientUserMessageId: input.requestId, input: text, expectedTurnId: input.expectedNativeTurnId!};
      const response = record(await this.rpc!.call(input.mode === 'next-turn' ? 'turn/start' : 'turn/steer', params));
      const nativeTurnId = input.mode === 'next-turn' ? string(record(response.turn).id, 'turn.id') : string(response.turnId, 'turnId');
      if (!this.completedTurns.has(nativeTurnId)) this.activeTurn = nativeTurnId;
      if (this.saved) this.saved.lastNativeTurnId = nativeTurnId;
      return this.receipt({requestId: input.requestId, nativeTurnId, status: this.completedTurns.has(nativeTurnId) ? 'completed' : 'accepted'});
    } catch (error) {
      const old = this.submissions.get(input.requestId)!;
      return this.receipt({...old, status: error instanceof RpcError && !old.nativeTurnId ? 'rejected' : 'unknown', evidence: errorText(error)});
    } finally {this.sending = undefined;}
  }
  private message(message: RpcMessage): void {
    const method = string(message.method, 'method');
    const params = record(message.params ?? {});
    if (message.id !== undefined) {this.serverRequest(message, params); return;}
    if (params.threadId && this.live?.nativeSessionId && params.threadId !== this.live.nativeSessionId) return;
    if (method === 'turn/started') {
      const turnId = string(record(params.turn).id, 'turn.id'); this.activeTurn = turnId; this.startedTurns.add(turnId);
      if (this.saved) this.saved.lastNativeTurnId = turnId;
      const requestId = this.sending?.requestId;
      if (requestId) this.receipt({requestId, status: 'accepted', nativeTurnId: turnId});
      this.emit({type: 'turn.started', nativeTurnId: turnId, ...(requestId ? {requestId} : {})});
    } else if (method === 'turn/completed') {
      const turn = record(params.turn), turnId = string(turn.id, 'turn.id');
      this.completedTurns.add(turnId); if (this.activeTurn === turnId) this.activeTurn = undefined;
      this.fileChanges.clear();
      for (const receipt of this.submissions.values()) if (receipt.nativeTurnId === turnId) this.receipt({...receipt, status: 'completed'});
      for (const [key, request] of this.requests) if (request.request.nativeTurnId === turnId) {clearTimeout(request.timer); this.requests.delete(key); this.emit({type: 'request.resolved', requestId: key});}
      this.emit({type: 'turn.completed', nativeTurnId: turnId, outcome: turn.status === 'completed' ? 'success' : turn.status === 'interrupted' ? 'interrupted' : 'failed'});
    } else if (method === 'item/agentMessage/delta') {
      this.emit({type: 'message.delta', itemId: string(params.itemId, 'itemId'), text: string(params.delta, 'delta')});
    } else if (method === 'item/started' || method === 'item/completed') {
      const item = record(params.item), name = String(item.type);
      if (['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch'].includes(name)) {
        if (method === 'item/started') {
          if (name === 'fileChange') this.fileChanges.set(string(item.id, 'item.id'), (item.changes ?? []) as Json);
          this.emit({type: 'tool.started', itemId: string(item.id, 'item.id'), name, input: name === 'fileChange' ? {changes: (item.changes ?? []) as Json} : {description: String(item.command ?? item.tool ?? name)}});
        }
        else this.emit({type: 'tool.completed', itemId: string(item.id, 'item.id'), success: item.status !== 'failed' && item.status !== 'declined'});
      }
    } else if (method === 'thread/tokenUsage/updated') {
      const usage = record(record(params.tokenUsage).total);
      this.emit({type: 'usage.updated', inputTokens: Number(usage.inputTokens ?? 0), outputTokens: Number(usage.outputTokens ?? 0)});
    } else if (method === 'error') {
      // willRetry describes this turn, not the health of the connection.
      this.emit({type: 'adapter.error', code: 'NATIVE_ERROR', message: String(record(params.error).message ?? 'Codex error'), recoverable: true});
    } else if (method === 'serverRequest/resolved') {
      for (const [key, request] of this.requests) if (request.id === params.requestId) {clearTimeout(request.timer); this.requests.delete(key); this.emit({type: 'request.resolved', requestId: key});}
    }
  }
  private serverRequest(message: RpcMessage, params: Record<string, unknown>): void {
    const rawId = message.id;
    if (typeof rawId !== 'number' && typeof rawId !== 'string') throw new Error('Invalid server request ID');
    if (params.threadId && params.threadId !== this.live?.nativeSessionId) {this.rpc!.send({id: rawId, error: {code: -32602, message: 'Unknown thread'}}); return;}
    const method = String(message.method), requestId = id();
    const base = {requestId, connectionEpoch: this.live!.connectionEpoch, nativeTurnId: typeof params.turnId === 'string' ? params.turnId : undefined, expiresAt: new Date(Date.now() + (this.options.approvalTimeoutMs ?? 180000)).toISOString()};
    let request: PendingRequest;
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      const changes = this.fileChanges.get(String(params.itemId));
      request = {...base, kind: 'approval', toolName: method.includes('commandExecution') ? 'commandExecution' : 'fileChange', description: String(params.command ?? params.reason ?? 'File changes'), input: {...params, ...(changes ? {changes} : {})} as Json};
    } else if (method === 'item/tool/requestUserInput') {
      if ((params.questions as unknown[]).some(raw => record(raw).isSecret === true)) {
        this.rpc!.send({id: rawId, error: {code: -32601, message: 'Secret input is not supported by this client; no answer provided'}});
        this.emit({type: 'adapter.error', code: 'UNSUPPORTED_SECRET_INPUT', message: 'Secret input request declined; session remains open', recoverable: true});
        return;
      }
      request = {...base, kind: 'question', questions: (params.questions as unknown[]).map(raw => {
        const question = record(raw);
        return {id: string(question.id, 'question.id'), text: string(question.question, 'question'), allowFreeText: question.isOther === true || question.options == null, ...(Array.isArray(question.options) ? {options: question.options.map(option => string(record(option).label, 'label'))} : {})};
      })};
    } else {this.rpc!.send({id: rawId, error: {code: -32601, message: 'Unsupported client request; no permission granted'}}); return;}
    const timer = setTimeout(() => {
      try {this.rpc!.send(request.kind === 'approval' ? {id: rawId, result: {decision: 'decline'}} : {id: rawId, error: {code: -32000, message: 'Question expired'}});} catch { /* disconnected */ }
      this.requests.delete(requestId); this.emit({type: 'request.resolved', requestId});
    }, this.options.approvalTimeoutMs ?? 180000);
    this.requests.set(requestId, {id: rawId, request, timer});
    this.emit({type: 'request.pending', request});
  }
  async interrupt(session: LiveSession, nativeTurnId: string): Promise<void> {
    this.check(session);
    // turn/start can acknowledge a queued turn before it becomes interruptible.
    const deadline = Date.now() + (this.options.timeoutMs ?? 30000);
    while (nativeTurnId === this.activeTurn && !this.startedTurns.has(nativeTurnId)) {
      if (Date.now() >= deadline) throw new Error('Turn has been accepted but has not started yet');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (this.completedTurns.has(nativeTurnId)) return;
    if (nativeTurnId !== this.activeTurn) throw new Error('Turn is no longer active');
    await this.rpc!.call('turn/interrupt', {threadId: session.nativeSessionId, turnId: nativeTurnId});
  }
  async answer(session: LiveSession, requestId: string, answer: RequestAnswer): Promise<void> {
    this.check(session); const pending = this.requests.get(requestId);
    if (!pending || pending.request.connectionEpoch !== session.connectionEpoch || Date.parse(pending.request.expiresAt) <= Date.now()) throw new Error('Request expired or connection changed');
    if (pending.request.kind !== answer.kind) throw new Error('Answer kind does not match request');
    let result: unknown;
    if (answer.kind === 'approval') result = {decision: answer.decision === 'allow-once' ? 'accept' : 'decline'};
    else {
      const questions = pending.request.kind === 'question' ? pending.request.questions : [];
      const answers: Record<string, {answers: string[]}> = {};
      for (const question of questions) {
        const value = answer.answers[question.id];
        if (!value || (!question.allowFreeText && !question.options?.includes(value))) throw new Error(`Invalid answer for ${question.id}`);
        answers[question.id] = {answers: [value]};
      }
      result = {answers};
    }
    this.rpc!.send({id: pending.id, result}); clearTimeout(pending.timer); this.requests.delete(requestId); this.emit({type: 'request.resolved', requestId});
  }
  async reconcile(session: LiveSession, pending: readonly SubmissionReceipt[]): Promise<readonly SubmissionReceipt[]> {
    this.check(session);
    const response = record(await this.rpc!.call('thread/read', {threadId: session.nativeSessionId, includeTurns: true}));
    const turns = record(response.thread).turns;
    const finished = new Set(Array.isArray(turns) ? turns.filter(turn => ['completed', 'interrupted', 'failed'].includes(String(record(turn).status))).map(turn => record(turn).id) : []);
    return pending.map(receipt => receipt.nativeTurnId && finished.has(receipt.nativeTurnId) ? {...receipt, status: 'completed', evidence: 'Matched native turn ID in thread history'} : {...receipt, status: 'unknown', evidence: 'No conclusive native completion; input was not resent'});
  }
  async checkpoint(session: LiveSession): Promise<SessionCheckpoint> {this.check(session); if (!this.saved) throw new ConnectionError('No checkpoint'); return structuredClone(this.saved);}
  async close(session: LiveSession): Promise<void> {
    this.check(session); this.closing = true;
    for (const pending of this.requests.values()) clearTimeout(pending.timer);
    this.requests.clear(); await this.rpc?.close(); this.queue.end();
  }
}
