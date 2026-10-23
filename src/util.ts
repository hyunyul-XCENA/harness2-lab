import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a protocol object');
  return value as Record<string, unknown>;
}
export function string(value: unknown, name = 'string'): string {
  if (typeof value !== 'string') throw new Error(`Expected ${name}`);
  return value;
}
export function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export const id = (): string => randomUUID();

export function assertNoSymlink(file: string): void {
  for (let current = path.resolve(file); current !== path.dirname(current); current = path.dirname(current)) {
    try {if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Symlink is not supported here: ${current}`);}
    catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
  }
}

export class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiters: {resolve: (value: IteratorResult<T>) => void; reject: (error: Error) => void}[] = [];
  private ended = false;
  private failure?: Error;
  constructor(private capacity = 4096) {}
  push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({value, done: false});
    else {
      if (this.values.length >= this.capacity) throw new Error('Event queue capacity exceeded');
      this.values.push(value);
    }
  }
  end(error?: Error): void {
    this.ended = true;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) {
      if (error) waiter.reject(error); else waiter.resolve({value: undefined, done: true});
    }
  }
  async next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return {value, done: false};
    if (this.failure) throw this.failure;
    if (this.ended) return {value: undefined, done: true};
    return new Promise((resolve, reject) => this.waiters.push({resolve, reject}));
  }
  [Symbol.asyncIterator](): AsyncIterator<T> { return this; }
}

export function atomicJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error(`Refusing symlink: ${file}`);
  const temporary = `${file}.${id()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary, file); }
  catch (error) { fs.unlinkSync(temporary); throw error; }
}

export async function stopProcessTree(pid: number | undefined): Promise<void> {
  if (!pid) return;
  if (process.platform === 'win32') {
    await new Promise<void>(resolve => {
      const child = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {windowsHide: true, stdio: 'ignore'});
      child.once('error', () => resolve()); child.once('exit', () => resolve());
    });
  } else {
    try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} }
    await new Promise(resolve => setTimeout(resolve, 100));
    try { process.kill(-pid, 'SIGKILL'); } catch {}
  }
}
