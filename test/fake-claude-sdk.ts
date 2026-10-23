import type {Options, PermissionResult, SDKMessage, SDKUserMessage, SessionMessage} from '@anthropic-ai/claude-agent-sdk';
import type {ClaudeSdk} from '../src/adapters/claude.js';
import {AsyncQueue, id} from '../src/util.js';

/** SDK boundary fixture. No model, shell, credential or project config is read. */
export class FakeClaudeSdk implements ClaudeSdk {
  histories = new Map<string, SessionMessage[]>();
  options: Options[] = [];
  inputs: SDKUserMessage[] = [];
  decisions: PermissionResult[] = [];
  closeCount = 0;
  inspectedVersion = '2.1.309';
  overrideModel?: string;
  version = async () => this.inspectedVersion;
  info: ClaudeSdk['info'] = async sessionId => this.histories.has(sessionId) ? {sessionId, summary: 'fixture', lastModified: 1, fileSize: 1} : undefined;
  messages: ClaudeSdk['messages'] = async sessionId => this.histories.get(sessionId) ?? [];
  query: ClaudeSdk['query'] = ({prompt, options}) => {
    this.options.push(options);
    const sessionId = options.resume ?? options.sessionId!;
    const history = this.histories.get(sessionId) ?? []; this.histories.set(sessionId, history);
    const output = new AsyncQueue<SDKMessage>();
    const cancellation = new AbortController();
    let current: SDKUserMessage | undefined, closed = false, started = false, timer: NodeJS.Timeout | undefined;
    const send = (message: Record<string, unknown>) => output.push({...message, session_id: sessionId, uuid: id()} as unknown as SDKMessage);
    const assistant = (text: string) => {
      const messageId = id();
      send({type: 'stream_event', parent_tool_use_id: null, user_message_uuid: current!.uuid, event: {type: 'message_start', message: {id: messageId}}});
      send({type: 'stream_event', parent_tool_use_id: null, event: {type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text}}});
      const message = {role: 'assistant', id: messageId, content: [{type: 'text', text}], stop_reason: 'end_turn'};
      history.push({type: 'assistant', uuid: id(), session_id: sessionId, message, parent_tool_use_id: null, parent_agent_id: null});
      send({type: 'assistant', user_message_uuid: current!.uuid, parent_tool_use_id: null, message});
    };
    const finish = (text: string, kind: 'success' | 'failed' | 'interrupted' = 'success') => {
      if (!current || closed) return;
      clearTimeout(timer);
      if (text) assistant(text);
      send({type: 'result', user_message_uuid: current.uuid, subtype: kind === 'failed' ? 'error_during_execution' : 'success', is_error: kind !== 'success', result: text, errors: kind === 'failed' ? ['fixture failed'] : [], terminal_reason: kind === 'interrupted' ? 'aborted_streaming' : kind === 'failed' ? 'api_error' : 'completed', usage: {}, modelUsage: {'fixture-model': {inputTokens: 5, outputTokens: 3}}, total_cost_usd: 0.001});
      current = undefined;
    };
    void (async () => {
      for await (const input of prompt) {
        if (closed) break;
        current = input; started = false; this.inputs.push(input);
        history.push({type: 'user', uuid: input.uuid!, session_id: sessionId, message: input.message, parent_tool_use_id: null, parent_agent_id: null});
        const text = String(input.message.content);
        if (text === 'timeout') continue;
        output.push({...input, isReplay: true} as SDKMessage);
        if (text === 'disconnect') {output.end(new Error('fixture disconnected')); continue;}
        send({type: 'system', subtype: 'init', model: this.overrideModel ?? options.model ?? 'fixture-model', claude_code_version: '2.1.309'});
        const start = () => {started = true; send({type: 'stream_event', user_message_uuid: input.uuid, parent_tool_use_id: null, event: {type: 'message_start', message: {id: id()}}});};
        if (text === 'delayed') {timer = setTimeout(start, 60); continue;}
        start();
        if (text === 'long') continue;
        if (text === 'approval' || text === 'question' || text === 'multi') {
          const isApproval = text === 'approval';
          const decision = await options.canUseTool!(isApproval ? 'Write' : 'AskUserQuestion', isApproval ? {file_path: 'example.txt', content: 'concrete proposed contents'} : {questions: [{question: 'Language?', header: 'Language', options: [{label: 'Korean'}, {label: 'English'}], multiSelect: text === 'multi'}]}, {signal: cancellation.signal, toolUseID: id(), requestId: id()});
          if (!decision) throw new Error('Expected an explicit permission result');
          this.decisions.push(decision); finish(decision.behavior); continue;
        }
        if (text === 'failed') {finish('', 'failed'); continue;}
        const remembered = history.filter(message => message.type === 'user').map(message => String((message.message as {content: string}).content)).find(value => value.startsWith('remember '))?.slice(9);
        timer = setTimeout(() => finish(text === 'recall' ? remembered ?? '' : `reply:${text}`), 20);
      }
    })().catch(error => output.end(error));
    return {
      [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
      initializationResult: async () => ({claude_code_version: '2.1.309'}),
      interrupt: async () => {if (!started) throw new Error('Native turn not started'); finish('', 'interrupted'); return {still_queued: []};},
      close: () => {if (closed) return; closed = true; this.closeCount++; clearTimeout(timer); cancellation.abort(); output.end();},
    };
  };
}
