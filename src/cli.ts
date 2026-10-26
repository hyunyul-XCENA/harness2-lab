#!/usr/bin/env node
import path from 'node:path';
import {parseArgs} from 'node:util';
import {compileHarness, createSpec, initializeHome, loadConfig} from './config.js';
import {StateStore} from './storage.js';
import {CodexAdapter} from './adapters/codex.js';
import {ClaudeAdapter} from './adapters/claude.js';
import {SessionManager} from './session.js';
import {errorText, id} from './util.js';
import {help} from './commands.js';
import {chooseSession, TuiApp, type Selection} from './ui/app.js';
import {PlainApp} from './ui/plain.js';
import {Screen} from './ui/terminal.js';

async function main(): Promise<void> {
  const {values} = parseArgs({options: {project: {type: 'string', default: process.cwd()}, engine: {type: 'string'}, home: {type: 'string'}, model: {type: 'string'}, resume: {type: 'string'}, 'codex-path': {type: 'string'}, 'claude-path': {type: 'string'}, sessions: {type: 'boolean'}, select: {type: 'boolean'}, plain: {type: 'boolean'}, tui: {type: 'boolean'}, help: {type: 'boolean'}}});
  if (values.help) {console.log(help); return;}
  if (values.plain && values.tui) throw new Error('Choose --plain or --tui');
  const terminal = !!process.stdin.isTTY && !!process.stdout.isTTY;
  const tui = !values.plain && terminal;
  if ((values.tui || values.select) && !terminal) throw new Error('--tui / --select needs an interactive terminal');
  if (values.select && (values.plain || values.engine || values.resume || values.model)) throw new Error('--select cannot be combined with --plain, --engine, --resume or --model');
  const requestedProject = path.resolve(values.project!);
  const overrides = {...(values.engine ? {engine: values.engine} : {}), ...(values.model ? {model: values.model} : {})};
  const initial = loadConfig(requestedProject, values.home, Object.keys(overrides).length ? {runtime: overrides} : {});
  const project = initial.config.project.path;
  if (initial.config.improvement.enabled) throw new Error('Improvement experiments are not implemented yet; set improvement.enabled=false');
  const store = new StateStore(initial.stateDirectory);
  let manager: SessionManager | undefined;
  let app: TuiApp | PlainApp | undefined;
  let surface: Screen | undefined;
  try {
    if (values.sessions) {console.table(store.list()); return;}
    store.acquire(); initializeHome(initial.home);
    if (tui) surface = new Screen(process.stdin, process.stdout, () => {}, () => ({lines: ['Opening…']}));
    let selection: Selection | undefined;
    if (values.select || (tui && !values.engine && !values.resume && !values.model)) selection = await chooseSession(store, project, process.stdin, process.stdout, initial.config.runtime.engine, surface);
    else selection = {engine: values.resume ? store.checkpoint(values.resume).runtime.engine : initial.config.runtime.engine, ...(values.resume ? {resume: values.resume} : {})};
    if (values.resume && values.engine && selection?.engine !== values.engine) throw new Error('Resume pins the saved engine; start a new session to switch engines');
    if (values.resume && values.model) throw new Error('Resume pins the saved model; start a new session to change it');
    let first = true;
    while (selection) {
      const loaded = loadConfig(project, values.home, {runtime: {engine: selection.engine, ...(first && values.model ? {model: values.model} : {})}});
      first = false;
      const adapter = selection.engine === 'claude' ? new ClaudeAdapter({command: values['claude-path'], timeoutMs: loaded.config.runtime.startupTimeoutMs}) : new CodexAdapter({command: values['codex-path'], timeoutMs: loaded.config.runtime.startupTimeoutMs});
      manager = new SessionManager(adapter, store);
      app = tui ? new TuiApp(manager, project, selection.engine, process.stdin, process.stdout, selection.resume, surface) : new PlainApp(manager);
      if (selection.resume) await manager.resume(selection.resume, project);
      else await manager.start(createSpec(loaded.config, compileHarness(loaded.config, loaded.home), id()));
      app.ready();
      const action = await app.finished;
      if (app.closeError) throw app.closeError;
      await manager.close(); app.dispose(); app = undefined; manager = undefined;
      selection = action === 'select' ? await chooseSession(store, project, process.stdin, process.stdout, initial.config.runtime.engine, surface) : undefined;
    }
  } finally {
    // Always restore terminal modes even when startup/version validation fails.
    try {await manager?.close();} finally {app?.dispose(); surface?.close(); store.close();}
  }
}
main().catch(error => {console.error(errorText(error)); process.exitCode = 1;});
