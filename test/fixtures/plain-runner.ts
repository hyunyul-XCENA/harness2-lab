import fs from 'node:fs';
import path from 'node:path';
import {compileHarness, createSpec, initializeHome, loadConfig} from '../../src/config.js';
import {ClaudeAdapter} from '../../src/adapters/claude.js';
import {StateStore} from '../../src/storage.js';
import {SessionManager} from '../../src/session.js';
import {PlainApp} from '../../src/ui/plain.js';
import {id} from '../../src/util.js';
import {FakeClaudeSdk} from '../fake-claude-sdk.js';
const project = process.argv[2]!, home = path.join(project, 'home'); fs.mkdirSync(project, {recursive: true}); initializeHome(home);
const loaded = loadConfig(project, home, {runtime: {engine: 'claude'}}), store = new StateStore(loaded.stateDirectory); store.acquire();
const provider = new FakeClaudeSdk(), manager = new SessionManager(new ClaudeAdapter({timeoutMs: 500}, provider), store), app = new PlainApp(manager);
try {
  await manager.start(createSpec(loaded.config, compileHarness(loaded.config, home), id())); app.ready(); await app.finished;
  if (app.closeError) throw app.closeError;
} finally {await manager.close(); app.dispose(); store.close();}
console.log(`fixture closed ${provider.closeCount}`);
