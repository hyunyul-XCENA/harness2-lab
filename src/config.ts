import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Ajv2020} from 'ajv/dist/2020.js';
import type {HarnessSnapshot, SessionSpec} from '../contracts/agent.js';
import {assertNoSymlink, atomicJson, record} from './util.js';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const assets = [path.resolve(moduleDirectory, '..'), path.resolve(moduleDirectory, '../..')].find(dir => fs.existsSync(path.join(dir, 'contracts/runner-config.schema.json')))!;
const json = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8'));
const optionalJson = (file: string): Record<string, unknown> => fs.existsSync(file) ? record(json(file)) : {};
const ajv = new Ajv2020({allErrors: true});
const schema = record(json(path.join(assets, 'contracts/runner-config.schema.json')));
const validate = ajv.compile(schema);

export interface RunnerConfig {
  schemaVersion: 1;
  project: {path: string};
  runtime: {engine: 'codex' | 'claude'; model?: string | null; harness: string; permissionMode: 'interactive'; startupTimeoutMs: number; maxQueuedMessages: 1; claude?: {settingsSources: ('user' | 'project' | 'local')[]}};
  improvement: {enabled: boolean; trigger: 'manual'; editable: string[]; isolation: 'container'; maxCandidates: number; repetitions: number; maxWallTimeSeconds: number; validationRecipes: string[]};
}

export function mergeConfig(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const result = {...base};
  const oldRuntime = record(base.runtime ?? {}), newRuntime = record(overlay.runtime ?? {});
  if (newRuntime.engine && newRuntime.engine !== oldRuntime.engine) {
    const clean = {...oldRuntime}; delete clean.model; delete clean.claude; result.runtime = clean;
  }
  for (const [key, value] of Object.entries(overlay)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error(`Invalid configuration key: ${key}`);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const old = result[key];
      result[key] = mergeConfig(old && typeof old === 'object' && !Array.isArray(old) ? record(old) : {}, record(value));
    } else result[key] = value;
  }
  return result;
}

export function loadConfig(project: string, home = path.join(os.homedir(), '.terminal-runner'), overrides: Record<string, unknown> = {}): {config: RunnerConfig; home: string; stateDirectory: string} {
  const cwd = fs.realpathSync(project);
  const shared = optionalJson(path.join(home, 'defaults.json'));
  if ('project' in shared) throw new Error('Common defaults cannot set project.path');
  const local = optionalJson(path.join(cwd, '.terminal-runner/runner.config.json'));
  const defaults = record(json(path.join(assets, 'examples/runner.config.json')));
  const runtime = record(defaults.runtime); runtime.harness = 'global:coding-v1';
  let resolved = mergeConfig(mergeConfig(mergeConfig(defaults, shared), local), overrides);
  resolved = {...resolved, project: {path: cwd}};
  if (!validate(resolved)) throw new Error(`Invalid config: ${ajv.errorsText(validate.errors)}`);
  return {config: resolved as unknown as RunnerConfig, home: path.resolve(home), stateDirectory: path.join(cwd, '.terminal-runner')};
}

export function initializeHome(home: string): void {
  const target = path.join(home, 'harnesses/coding-v1');
  assertNoSymlink(target);
  if (fs.existsSync(target)) {
    if (fs.lstatSync(target).isSymbolicLink()) throw new Error('Common harness cannot be a symlink');
    if (!fs.existsSync(path.join(target, 'manifest.json'))) throw new Error('Common harness is incomplete; inspect its directory before retrying');
    return;
  }
  fs.mkdirSync(target, {recursive: true});
  for (const name of ['instructions.md', 'manifest.json']) {
    const source = path.join(assets, 'examples/harnesses/coding-v1', name);
    try { fs.copyFileSync(source, path.join(target, name), fs.constants.COPYFILE_EXCL); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
}

export function digest(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }

export function compileHarness(config: RunnerConfig, home: string): HarnessSnapshot {
  const [scope, harnessId] = config.runtime.harness.split(':') as ['global' | 'project', string];
  const parent = scope === 'global' ? home : path.join(config.project.path, '.terminal-runner');
  const root = path.join(parent, 'harnesses', harnessId);
  for (let current = root; current !== path.dirname(current); current = path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Harness path contains a symlink');
  }
  const manifest = record(json(path.join(root, 'manifest.json')));
  const manifestSchema = record(json(path.join(assets, 'contracts/harness.schema.json')));
  const check = ajv.getSchema(String(manifestSchema.$id)) ?? ajv.compile(manifestSchema);
  if (!check(manifest) || manifest.id !== harnessId) throw new Error('Invalid harness manifest');
  const files: {path: string; kind: string; content: string}[] = [];
  const seen = new Set<string>();
  for (const entry of manifest.files as {path: string; kind: string}[]) {
    const parts = entry.path.split('/');
    if (path.isAbsolute(entry.path) || /[\\:]/.test(entry.path) || parts.some(p => ['', '.', '..'].includes(p)) || seen.has(entry.path)) throw new Error('Invalid harness file path');
    seen.add(entry.path);
    let file = root;
    for (const part of parts) { file = path.join(file, part); if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Harness file contains a symlink'); }
    if (!fs.statSync(file).isFile() || fs.statSync(file).size > 1024 * 1024) throw new Error('Invalid harness file or file too large');
    if (entry.kind !== 'instructions') throw new Error('This milestone supports instructions only; skills/scripts activation comes next');
    files.push({...entry, content: fs.readFileSync(file, 'utf8')});
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const bundleDigest = digest(JSON.stringify({scope, id: harnessId, files, engine: config.runtime.engine, compiler: '1'}));
  const existingRules = ['AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md'].map(name => {
    const file = path.join(config.project.path, name);
    return [name, fs.existsSync(file) ? digest(fs.readFileSync(file)) : null];
  });
  const output = path.join(config.project.path, '.terminal-runner/materialized', bundleDigest);
  assertNoSymlink(output);
  fs.mkdirSync(output, {recursive: true});
  const bundle = path.join(output, 'bundle.json');
  assertNoSymlink(bundle);
  const contents = {scope, id: harnessId, files, digest: bundleDigest};
  if (fs.existsSync(bundle)) {
    if (JSON.stringify(json(bundle)) !== JSON.stringify(contents)) throw new Error('Materialized harness was modified');
  } else atomicJson(bundle, contents);
  return {id: harnessId, scope, digest: bundleDigest, compilerVersion: '1', projectInstructionsDigest: digest(JSON.stringify(existingRules)), materializedDirectory: output, appendedInstructions: files.map(f => f.content).join('\n\n')};
}

export function createSpec(config: RunnerConfig, harness: HarnessSnapshot, appSessionId: string): SessionSpec {
  return {appSessionId, cwd: config.project.path, ...(config.runtime.model ? {model: config.runtime.model} : {}), harness, permissionMode: 'interactive', ...(config.runtime.claude ? {claude: config.runtime.claude} : {})};
}
