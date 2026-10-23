import {execFile, spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {promisify} from 'node:util';
import {query, getSessionInfo, getSessionMessages, type CanUseTool, type Options, type PermissionResult, type SDKMessage, type SDKUserMessage} from '@anthropic-ai/claude-agent-sdk';
import type {AgentAdapter, AgentEvent, Capabilities, EventPayload, InputMessage, Json, LiveSession, PendingRequest, RequestAnswer, RuntimeIdentity, SessionCheckpoint, SessionSpec, SubmissionReceipt} from '../../contracts/agent.js';
import {AsyncQueue, errorText, id, record, stopProcessTree} from '../util.js';

export const CLAUDE_VERSION = '2.1.309';
export const CLAUDE_SDK_VERSION = '0.3.309';
const capabilities: Capabilities = {persistentInput: true, resume: true, interrupt: true, midTurnInput: 'queue', approvalRequests: true, userQuestions: true, hardCostLimit: false, hardTokenLimit: false};
export interface ClaudeOptions {command?: string; timeoutMs?: number; approvalTimeoutMs?: number; env?: NodeJS.ProcessEnv; tools?: string[]}
type SdkQuery = AsyncIterable<SDKMessage> & {initializationResult(): Promise<{claude_code_version?: string}>; interrupt(): Promise<unknown>; close(): void};
export interface ClaudeSdk {
  query(params: {prompt: AsyncIterable<SDKUserMessage>; options: Options}): SdkQuery;
  info: typeof getSessionInfo;
  messages: typeof getSessionMessages;
  version?: () => Promise<string>; // deterministic test seam; the CLI never supplies this
}
const sdk: ClaudeSdk = {query, info: getSessionInfo, messages: getSessionMessages};
type InFlight = {input: InputMessage; receipt: SubmissionReceipt; resolve: (receipt: SubmissionReceipt) => void; timer: NodeJS.Timeout; interrupted: boolean; started: boolean};
type QuestionMap = {id: string; nativeText: string; options: string[]; allowFreeText: boolean};
type NativeRequest = {request: PendingRequest; input: Record<string, unknown>; questions?: QuestionMap[]; finish: (result: PermissionResult) => void};

/** The input generator stays open across results; each result ends one turn only. */
export class ClaudeAdapter implements AgentAdapter {
  readonly engine = 'claude' as const;
  private live?: LiveSession;
  private saved?: SessionCheckpoint;
  private native?: SdkQuery;
  private input = new AsyncQueue<SDKUserMessage>(1);
  private output = new AsyncQueue<AgentEvent>();
  private subscribed = false;
  private closing = false;
  private closeTask?: Promise<void>;
  private pump?: Promise<void>;
  private child?: ChildProcessWithoutNullStreams;
  private exited?: Promise<void>;
  private active?: InFlight;
  private submissions = new Map<string, SubmissionReceipt>();
  private requests = new Map<string, NativeRequest>();
  private streamedMessages = new Set<string>();
  private messageId = '';
  private tools = new Set<string>();
  private disconnected = false;
  constructor(private options: ClaudeOptions = {}, private provider: ClaudeSdk = sdk) {}
  private get command(): string {return this.options.command ?? (process.platform === 'win32' ? 'claude.exe' : 'claude');}
  async inspect(): Promise<{runtime: RuntimeIdentity; capabilities: Capabilities}> {
    const version = this.provider.version ? await this.provider.version() : /^(\S+)/.exec((await promisify(execFile)(this.command, ['--version'], {windowsHide: true, timeout: this.options.timeoutMs ?? 15000, env: this.options.env})).stdout)?.[1];
    if (version !== CLAUDE_VERSION) throw new Error(`Supported Claude Code version: ${CLAUDE_VERSION}; installed: ${version ?? 'unknown'}`);
    return {runtime: {engine: 'claude', executableVersion: version, sdkVersion: CLAUDE_SDK_VERSION, protocolVersion: 'agent-sdk-streaming'}, capabilities};
  }
  private check(session: LiveSession): void {
    if (!this.live || session.connectionEpoch !== this.live.connectionEpoch || session.appSessionId !== this.live.appSessionId) throw new Error('Stale or unknown Claude connection');
  }
  private emit(payload: EventPayload): void {
    if (!this.live) return;
    try {this.output.push({eventId: id(), appSessionId: this.live.appSessionId, connectionEpoch: this.live.connectionEpoch, receivedAt: new Date().toISOString(), payload});}
    catch (error) {this.output.end(new Error(`Claude event consumer fell behind: ${errorText(error)}`)); void this.shutdown().catch(() => {});}
  }
  private receipt(receipt: SubmissionReceipt): SubmissionReceipt {
    const old = this.submissions.get(receipt.requestId);
    if (old?.status === 'completed' || old?.status === 'rejected') return old;
    this.submissions.set(receipt.requestId, receipt); this.emit({type: 'submission.changed', receipt}); return receipt;
  }
  private async bounded<T>(promise: Promise<T>, description: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {return await Promise.race([promise, new Promise<never>((_, reject) => {timer = setTimeout(() => reject(new Error(`${description} timed out`)), this.options.timeoutMs ?? 30000);})]);}
    finally {clearTimeout(timer);}
  }
  private async open(spec: SessionSpec, previous?: SessionCheckpoint): Promise<LiveSession> {
    if (this.native) throw new Error('Use a fresh Claude adapter for each connection');
    if (!spec.claude) throw new Error('Claude settingsSources must be explicit');
    const {runtime} = await this.inspect();
    if (previous && JSON.stringify(previous.runtime) !== JSON.stringify(runtime)) throw new Error('Claude runtime/SDK changed; use the original versions to resume');
    if (previous && !await this.provider.info(previous.nativeSessionId, {dir: spec.cwd})) throw new Error('Native Claude transcript was not found; no input has been resent');
    const nativeSessionId = previous?.nativeSessionId ?? id();
    this.live = {appSessionId: spec.appSessionId, nativeSessionId, connectionEpoch: id()};
    this.saved = {spec, runtime, nativeSessionId, lastJournalSequence: previous?.lastJournalSequence ?? 0, ...(previous?.resolvedModel ? {resolvedModel: previous.resolvedModel} : {}), ...(previous?.lastNativeTurnId ? {lastNativeTurnId: previous.lastNativeTurnId} : {})};
    try {
      this.native = this.provider.query({prompt: this.input, options: {
        cwd: spec.cwd, pathToClaudeCodeExecutable: this.command,
        ...(previous ? {resume: nativeSessionId} : {sessionId: nativeSessionId}),
        ...(previous?.resolvedModel ?? spec.model ? {model: previous?.resolvedModel ?? spec.model} : {}),
        settingSources: [...spec.claude.settingsSources], permissionMode: 'default',
        systemPrompt: {type: 'preset', preset: 'claude_code', append: spec.harness.appendedInstructions},
        includePartialMessages: true, persistSession: true,
        extraArgs: {'replay-user-messages': null},
        ...(this.options.env ? {env: this.options.env} : {}),
        ...(this.options.tools ? {tools: this.options.tools} : {}),
        canUseTool: this.canUseTool,
        spawnClaudeCodeProcess: options => {
          const child = this.child = spawn(options.command, options.args, {cwd: options.cwd, env: options.env, signal: options.signal, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe']});
          child.stderr.resume(); // Never forward account, credential or debug output to the journal.
          this.exited = new Promise(resolve => {child.once('exit', () => resolve()); child.once('error', () => resolve());});
          return child;
        },
      }});
      this.pump = this.consume();
      const initialization = await this.bounded(this.native.initializationResult(), 'Claude initialization');
      if (initialization.claude_code_version && initialization.claude_code_version !== CLAUDE_VERSION) throw new Error('Claude process version differs from inspected executable');
      if (this.disconnected) throw new Error('Claude connection ended during initialization');
      this.emit({type: 'session.ready', capabilities, checkpoint: structuredClone(this.saved)});
      return {...this.live};
    } catch (error) {await this.shutdown(); throw error;}
  }
  start(spec: SessionSpec): Promise<LiveSession> {return this.open(spec);}
  resume(checkpoint: SessionCheckpoint): Promise<LiveSession> {return this.open(checkpoint.spec, checkpoint);}
  events(session: LiveSession): AsyncIterable<AgentEvent> {this.check(session); if (this.subscribed) throw new Error('Events already subscribed'); this.subscribed = true; return this.output;}
  private async consume(): Promise<void> {
    try {for await (const message of this.native!) this.message(message); if (!this.closing) this.disconnect('Claude stream ended');}
    catch (error) {if (!this.closing) {this.disconnect(errorText(error)); void this.shutdown().catch(() => {});}}
  }
  private accept(requestId?: string, started = false): void {
    const active = this.active;
    if (!active || !requestId || requestId !== active.input.requestId) return;
    if (active.receipt.status !== 'accepted') {
      clearTimeout(active.timer);
      active.receipt = this.receipt({requestId: active.input.requestId, nativeTurnId: active.input.requestId, status: 'accepted', evidence: 'Native UUID acknowledgement or response'});
      this.saved!.lastNativeTurnId = active.input.requestId; active.resolve(active.receipt);
    }
    if (started && !active.started) {active.started = true; this.emit({type: 'turn.started', nativeTurnId: active.input.requestId, requestId: active.input.requestId});}
  }
  private message(message: SDKMessage): void {
    if ('parent_tool_use_id' in message && message.parent_tool_use_id) return;
    if (message.session_id && message.session_id !== this.live!.nativeSessionId) throw new Error('Claude session ID changed unexpectedly');
    if (message.type === 'system' && message.subtype === 'init') {
      if (this.saved!.resolvedModel && message.model !== this.saved!.resolvedModel) throw new Error('Claude resolved model changed; connection stopped');
      this.saved!.resolvedModel = message.model; return;
    }
    if (message.type === 'user') {
      if (message.uuid && message.uuid === this.active?.input.requestId) this.accept(message.uuid);
      if (Array.isArray(message.message.content)) for (const block of message.message.content) {
        if (block.type === 'tool_result') this.emit({type: 'tool.completed', itemId: block.tool_use_id, success: !block.is_error});
      }
    } else if (message.type === 'stream_event') {
      this.accept(message.user_message_uuid, true);
      const event = message.event;
      if (event.type === 'message_start') this.messageId = event.message.id;
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        this.streamedMessages.add(this.messageId); this.emit({type: 'message.delta', itemId: this.messageId || message.uuid, text: event.delta.text});
      }
    } else if (message.type === 'assistant') {
      this.accept(message.user_message_uuid, true);
      for (const block of message.message.content) {
        if (block.type === 'text' && !this.streamedMessages.has(message.message.id)) this.emit({type: 'message.delta', itemId: message.message.id, text: block.text});
        if (block.type === 'tool_use' && !this.tools.has(block.id)) {this.tools.add(block.id); this.emit({type: 'tool.started', itemId: block.id, name: block.name, input: block.input as Json});}
      }
    } else if (message.type === 'result') {
      const active = this.active;
      if (!active || (message.user_message_uuid !== active.input.requestId && !message.user_message_uuids?.includes(active.input.requestId))) return;
      this.accept(active.input.requestId, true);
      clearTimeout(active.timer);
      const nativeTurnId = active.input.requestId;
      active.receipt = this.receipt({requestId: nativeTurnId, nativeTurnId, status: 'completed', evidence: 'Native SDK result'}); active.resolve(active.receipt);
      this.active = undefined;
      for (const pending of [...this.requests.values()]) pending.finish({behavior: 'deny', message: 'Turn ended'});
      const failed = message.subtype !== 'success' || message.is_error;
      if (failed && !active.interrupted) this.emit({type: 'adapter.error', code: 'CLAUDE_TURN_FAILED', message: message.subtype === 'success' ? message.result : message.errors.join('\n'), recoverable: true});
      const usage = Object.values(message.modelUsage);
      this.emit({type: 'usage.updated', inputTokens: usage.reduce((sum, model) => sum + model.inputTokens, 0), outputTokens: usage.reduce((sum, model) => sum + model.outputTokens, 0), costUsdEstimate: message.total_cost_usd});
      this.tools.clear(); this.streamedMessages.clear();
      const interrupted = message.terminal_reason === 'aborted_streaming' || message.terminal_reason === 'aborted_tools' || (active.interrupted && failed && message.subtype !== 'success' && message.errors.some(error => /interrupt|abort/i.test(error)));
      this.emit({type: 'turn.completed', nativeTurnId, outcome: interrupted ? 'interrupted' : failed ? 'failed' : 'success'});
    }
  }
  async submit(session: LiveSession, input: InputMessage): Promise<SubmissionReceipt> {
    this.check(session);
    if (this.closing || this.disconnected) throw new Error('Claude connection is closed');
    if (input.mode !== 'next-turn') throw new Error('Claude supports queued follow-ups; /steer is not supported');
    if (this.active) throw new Error('Claude turn is already active');
    if (!input.text.trim() || this.submissions.has(input.requestId)) throw new Error('Empty input or duplicate request ID');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.requestId)) throw new Error('Claude input request ID must be a UUID');
    return new Promise(resolve => {
      const receipt = this.receipt({requestId: input.requestId, status: 'sent'});
      const timer = setTimeout(() => {this.disconnect('Claude acknowledgement timed out; input was not resent'); void this.shutdown().catch(() => {});}, this.options.timeoutMs ?? 30000);
      this.active = {input, receipt, resolve, timer, interrupted: false, started: false};
      try {this.input.push({type: 'user', uuid: input.requestId as NonNullable<SDKUserMessage['uuid']>, session_id: session.nativeSessionId, parent_tool_use_id: null, message: {role: 'user', content: input.text}});}
      catch (error) {this.disconnect(errorText(error)); void this.shutdown().catch(() => {});}
    });
  }
  private canUseTool: CanUseTool = async (toolName, input, options) => {
    if (this.closing || this.disconnected || options.signal.aborted || !this.active) return {behavior: 'deny', message: 'No active interactive session'};
    this.accept(this.active.input.requestId, true);
    const requestId = id(), expires = this.options.approvalTimeoutMs ?? 180000;
    const base = {requestId, connectionEpoch: this.live!.connectionEpoch, nativeTurnId: this.active!.input.requestId, expiresAt: new Date(Date.now() + expires).toISOString()};
    let questions: QuestionMap[] | undefined;
    let request: PendingRequest;
    if (toolName === 'AskUserQuestion') {
      if (!Array.isArray(input.questions) || input.questions.length === 0) return {behavior: 'deny', message: 'Malformed questions'};
      const raw = input.questions.map(record);
      if (raw.some(question => question.multiSelect === true || question.isSecret === true)) return {behavior: 'deny', message: 'Secret and multi-select questions are unsupported'};
      questions = raw.map((question, index) => ({id: `q${index + 1}`, nativeText: String(question.question), options: Array.isArray(question.options) ? question.options.map(option => String(record(option).label)) : [], allowFreeText: true}));
      request = {...base, kind: 'question', questions: questions.map(question => ({id: question.id, text: question.nativeText, options: question.options, allowFreeText: question.allowFreeText}))};
    } else request = {...base, kind: 'approval', toolName, description: options.title ?? options.description ?? String(input.command ?? input.file_path ?? toolName), input: input as Json};
    return new Promise<PermissionResult>(resolve => {
      let settled = false;
      const abort = () => finish({behavior: 'deny', message: 'Request cancelled'});
      const timer = setTimeout(() => finish({behavior: 'deny', message: 'User request expired'}), expires);
      const finish = (result: PermissionResult) => {
        if (settled) return; settled = true; clearTimeout(timer); options.signal.removeEventListener('abort', abort);
        this.requests.delete(requestId); this.emit({type: 'request.resolved', requestId}); resolve(result);
      };
      this.requests.set(requestId, {request, input, questions, finish}); options.signal.addEventListener('abort', abort, {once: true});
      if (options.signal.aborted) {abort(); return;}
      this.emit({type: 'request.pending', request});
    });
  };
  async answer(session: LiveSession, requestId: string, answer: RequestAnswer): Promise<void> {
    this.check(session); const pending = this.requests.get(requestId);
    if (!pending || pending.request.connectionEpoch !== session.connectionEpoch || Date.parse(pending.request.expiresAt) <= Date.now()) throw new Error('Request expired or connection changed');
    if (answer.kind !== pending.request.kind) throw new Error('Answer kind does not match request');
    if (answer.kind === 'approval') pending.finish(answer.decision === 'allow-once' ? {behavior: 'allow', updatedInput: pending.input, decisionClassification: 'user_temporary'} : {behavior: 'deny', message: 'User declined', decisionClassification: 'user_reject'});
    else {
      const answers: Record<string, string> = {};
      for (const question of pending.questions ?? []) {
        const value = answer.answers[question.id]; if (!value || (!question.allowFreeText && !question.options.includes(value))) throw new Error(`Invalid answer for ${question.id}`);
        answers[question.nativeText] = value;
      }
      pending.finish({behavior: 'allow', updatedInput: {...pending.input, answers}});
    }
  }
  async interrupt(session: LiveSession, nativeTurnId: string): Promise<void> {
    this.check(session); const active = this.active;
    if (!active || active.input.requestId !== nativeTurnId) throw new Error('Claude turn is no longer active');
    const deadline = Date.now() + (this.options.timeoutMs ?? 30000);
    while (this.active === active && !active.started && !this.disconnected) {
      if (Date.now() >= deadline) throw new Error('Claude accepted the input but execution has not started yet');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (this.active !== active) return;
    if (this.disconnected) throw new Error('Claude connection is closed');
    active.interrupted = true;
    try {await this.bounded(this.native!.interrupt(), 'Claude interrupt');}
    catch (error) {active.interrupted = false; throw error;}
  }
  async reconcile(session: LiveSession, pending: readonly SubmissionReceipt[]): Promise<readonly SubmissionReceipt[]> {
    this.check(session); if (!pending.length) return [];
    const messages = await this.provider.messages(session.nativeSessionId, {dir: this.saved!.spec.cwd});
    return pending.map(receipt => {
      const recorded = messages.some(message => message.type === 'user' && message.uuid === receipt.requestId && !message.parent_tool_use_id);
      // A model end_turn can precede Stop hooks and more model/tool calls. The
      // SDK transcript reader does not expose a durable outer result receipt.
      return {...receipt, status: 'unknown', evidence: recorded ? 'Native user UUID is recorded; outer SDK turn completion is unproven. Input was not resent' : 'Native completion is unproven; input was not resent'};
    });
  }
  async checkpoint(session: LiveSession): Promise<SessionCheckpoint> {this.check(session); return structuredClone(this.saved!);}
  private disconnect(reason: string): void {
    if (this.disconnected) return; this.disconnected = true;
    const active = this.active; const uncertain: string[] = [];
    if (active) {
      clearTimeout(active.timer); uncertain.push(active.input.requestId);
      active.receipt = this.receipt({...active.receipt, status: 'unknown', evidence: reason}); active.resolve(active.receipt); this.active = undefined;
    }
    for (const pending of [...this.requests.values()]) pending.finish({behavior: 'deny', message: 'Connection closed'});
    if (!this.closing) this.emit({type: 'transport.disconnected', uncertainRequestIds: uncertain, reason});
    this.output.end();
  }
  private shutdown(): Promise<void> {
    return this.closeTask ??= (async () => {
      this.closing = true; this.disconnect('Claude connection closed'); this.input.end(); this.native?.close();
      if (this.child?.pid && this.child.exitCode === null && this.child.signalCode === null) {
        await Promise.race([this.exited, new Promise(resolve => setTimeout(resolve, 200))]);
        if (this.child.exitCode === null && this.child.signalCode === null) await stopProcessTree(this.child.pid);
        await this.bounded(this.exited!, `Claude process exit (pid ${this.child.pid})`);
      }
      await this.pump; this.output.end();
    })();
  }
  close(session: LiveSession): Promise<void> {this.check(session); return this.shutdown();}
}
