import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {stopProcessTree} from './util.js';

const directory = path.dirname(fileURLToPath(import.meta.url));
export const packageRoot = [path.resolve(directory, '..'), path.resolve(directory, '../..')].find(root => fs.existsSync(path.join(root, 'python/harness2_runner.py')))!;

/** The host delegates the method to pinned upstream Python, without rewriting it. */
export async function runHarness2(args: string[]): Promise<number> {
  const python = process.env.HARNESS2_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const child = spawn(python, ['-u', '-X', 'utf8', path.join(packageRoot, 'python/harness2_runner.py'), ...args], {
    cwd: packageRoot, stdio: 'inherit', windowsHide: true, detached: process.platform !== 'win32',
    env: {...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1'},
  });
  let stopping: Promise<void> | undefined, signalCode: number | undefined;
  const stop = (code: number) => {signalCode ??= code; stopping ??= stopProcessTree(child.pid);};
  const interrupt = () => stop(130), terminate = () => stop(143);
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once('error', error => reject(new Error(`Cannot start ${python}: ${error.message}. Install Python 3.12/3.13 or set HARNESS2_PYTHON.`)));
      child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
    await stopping;
    return signalCode ?? code;
  } finally {process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);}
}
