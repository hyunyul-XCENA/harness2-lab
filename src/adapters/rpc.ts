import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import {EventEmitter} from 'node:events';
import {record, stopProcessTree, errorText} from '../util.js';

export class RpcError extends Error {constructor(message: string, readonly code?: number) {super(message);}}
export class ConnectionError extends Error {}
export type RpcMessage = Record<string, unknown>;
export interface ProcessOptions {command: string; args: string[]; cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv}

export class JsonRpcProcess extends EventEmitter {
  private child: ChildProcessWithoutNullStreams;
  private requests = new Map<number, {resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout}>();
  private nextId = 1;
  private closed = false;
  private closing = false;
  private buffer = '';
  private decoder = new StringDecoder('utf8');
  private stderr = '';
  constructor(private options: ProcessOptions) {
    super();
    this.child = spawn(options.command, options.args, {cwd: options.cwd, env: options.env ?? process.env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe']});
    this.child.stdout.on('data', (chunk: Buffer) => {
      try {
        this.buffer += this.decoder.write(chunk);
        if (this.buffer.length > 16 * 1024 * 1024) throw new Error('Protocol message exceeds 16 MiB');
        let end: number;
        while ((end = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, end).trim(); this.buffer = this.buffer.slice(end + 1);
          if (line) this.receive(record(JSON.parse(line)));
        }
      } catch (error) { this.disconnect(new ConnectionError(`Invalid protocol: ${errorText(error)}`)); void this.close(); }
    });
    this.child.stderr.on('data', (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString('utf8')).slice(-16384); });
    this.child.on('error', error => this.disconnect(new ConnectionError(error.message)));
    this.child.on('exit', (code, signal) => this.disconnect(new ConnectionError(`Codex process exited (${code ?? signal})`)));
    this.child.stdin.on('error', error => this.disconnect(new ConnectionError(error.message)));
  }
  private receive(message: RpcMessage): void {
    if (typeof message.method === 'string') { this.emit('message', message); return; }
    if (typeof message.id !== 'number') return;
    const request = this.requests.get(message.id);
    if (!request) return;
    this.requests.delete(message.id); clearTimeout(request.timer);
    if (message.error) {
      const error = record(message.error);
      request.reject(new RpcError(typeof error.message === 'string' ? error.message : 'Native RPC error', typeof error.code === 'number' ? error.code : undefined));
    } else request.resolve(message.result);
  }
  private disconnect(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(error); }
    this.requests.clear();
    this.emit('disconnected', error);
  }
  send(message: unknown): void {
    if (this.closed) throw new ConnectionError('Connection is closed');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  call(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new ConnectionError('Connection is closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.disconnect(new ConnectionError(`RPC timed out: ${method}; delivery may be unknown`)); void this.close(); }, this.options.timeoutMs ?? 30000);
      this.requests.set(id, {resolve, reject, timer});
      try { this.send({id, method, params}); }
      catch (error) { clearTimeout(timer); this.requests.delete(id); reject(error); }
    });
  }
  diagnostics(): string { return this.stderr; }
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.child.stdin.end();
    if (this.child.exitCode === null && this.child.signalCode === null) await stopProcessTree(this.child.pid);
    if (this.child.pid && this.child.exitCode === null && this.child.signalCode === null) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Could not confirm Codex process exit (pid ${this.child.pid})`)), 5000);
        this.child.once('exit', () => {clearTimeout(timer); resolve();});
      });
    }
    this.disconnect(new ConnectionError('Connection closed'));
  }
}
