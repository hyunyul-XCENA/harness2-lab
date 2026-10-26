/** Model-free, disposable preview for native-terminal acceptance checks. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {compileHarness, createSpec, initializeHome, loadConfig} from '../src/config.js';
import {ClaudeAdapter} from '../src/adapters/claude.js';
import {CodexAdapter} from '../src/adapters/codex.js';
import {StateStore} from '../src/storage.js';
import {SessionManager} from '../src/session.js';
import {chooseSession, TuiApp} from '../src/ui/app.js';
import {id} from '../src/util.js';
import {FakeClaudeSdk} from '../test/fake-claude-sdk.js';
const root = fileURLToPath(new URL('../../', import.meta.url));
const base = path.join(root, '.test-artifacts', `tui-preview-${id()}`), project = path.join(base, '한글 project'), home = path.join(base, 'home');
fs.mkdirSync(project, {recursive: true}); initializeHome(home);
const store = new StateStore(path.join(project, '.terminal-runner')); store.acquire();
const provider = new FakeClaudeSdk();
try {
  let selection = await chooseSession(store, `OFFLINE PREVIEW | ${project}`, process.stdin, process.stdout);
  while (selection) {
    const loaded = loadConfig(project, home, {runtime: {engine: selection.engine}});
    const adapter = selection.engine === 'claude' ? new ClaudeAdapter({timeoutMs: 1000}, provider) : new CodexAdapter({command: process.execPath, prefixArgs: [path.join(root, 'test/fixtures/fake-codex.mjs')], timeoutMs: 1000});
    const manager = new SessionManager(adapter, store), app = new TuiApp(manager, project, selection.engine, process.stdin, process.stdout, selection.resume);
    try {
      if (selection.resume) await manager.resume(selection.resume, project); else await manager.start(createSpec(loaded.config, compileHarness(loaded.config, home), id()));
      app.ready(); app.note('OFFLINE FIXTURE. Try: remember token / recall / long / approval / question. No model calls.');
      const action = await app.finished; if (app.closeError) throw app.closeError;
      selection = action === 'select' ? await chooseSession(store, project, process.stdin, process.stdout) : undefined;
    } finally {await manager.close(); app.dispose();}
  }
  fs.writeFileSync(path.join(base, 'result.json'), JSON.stringify({project, sessions: store.list(), inputs: store.list().map(row => ({id: row.id, inputs: store.inputs(row.id)}))}, null, 2));
} finally {store.close();}
console.log(`Preview state: ${base}`);
