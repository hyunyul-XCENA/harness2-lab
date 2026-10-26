import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {id} from '../src/util.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runner = path.join(root, 'dist/scripts/harness2.js');
const invoke = (args: string[]) => spawnSync(process.execPath, [runner, ...args], {cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60000});
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('original Harness² entrypoint runs PPC, final-only selection, earlier-task experience and resume at k=1 and k=2', () => {
  for (const k of [1, 2]) {
    const output = path.join(root, '.test-artifacts', `harness2-${id()}`);
    const args = ['demo', '--output', output, '--k', String(k), '--mode', 'both'];
    const result = invoke(args);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const report = read(path.join(output, 'demo.json'));
    assert.equal(report.done, 2); assert.equal(report.failed, 0); assert.equal(report.execution_count, 14 * k);
    assert.deepEqual(report.tasks[1].library_entries_before, {agg: 1, seq: 1});
    for (const task of ['ledger-1', 'ledger-2']) {
      const summary = read(path.join(output, 'runs', `demo-oc-agg${k}`, task, 'summary.json'));
      for (const mode of ['agg', 'seq']) {
        assert.equal(summary.modes[mode].ledger.R, 4 * k); assert.equal(summary.modes[mode].ledger.P, 3 * k);
        const selection = summary.selections[mode];
        assert.equal(selection.ok, true); assert.equal(selection.chosen_is_base, false); assert.equal(selection.trivial, k === 1);
        assert.match(selection.chosen_label, mode === 'agg' ? /^agg\d+$/ : /^c\d+$/);
        assert.ok(selection.experience.lesson);
        assert.equal(fs.readFileSync(path.join(selection.chosen_run_dir, 'answer.txt'), 'utf8').replace(/\r\n/g, '\n'), task === 'ledger-1' ? 'Total: 85.15\n' : 'Total: 20.25\n');
      }
    }
    const prefix = path.join(output, 'runs', `demo-oc-seq${k}`, 'ledger-2/context/inv1/library/harnesses');
    assert.deepEqual(fs.readdirSync(prefix), ['ledger-1']);
    const resumed = invoke(args); assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(read(path.join(output, 'demo.json')).execution_count, 0); assert.equal(read(path.join(output, 'demo.json')).editor_calls, 0);
    assert.ok(!resumed.stdout.includes('gpt-') && !resumed.stdout.includes('claude-'));
  }
});

test('original engine routing is separate from chat configuration and refuses unsafe demo output', () => {
  const output = path.join(root, '.test-artifacts', `harness2-user-${id()}`); fs.mkdirSync(output, {recursive: true});
  fs.writeFileSync(path.join(output, 'keep.txt'), 'user content');
  const denied = invoke(['demo', '--output', output]); assert.equal(denied.status, 1); assert.match(denied.stderr, /nonempty/);
  assert.equal(fs.readFileSync(path.join(output, 'keep.txt'), 'utf8'), 'user content');
  const cli = spawnSync(process.execPath, [path.join(root, 'dist/src/cli.js'), '--harness2', 'verify'], {cwd: root, encoding: 'utf8', windowsHide: true});
  assert.equal(cli.status, 0, cli.stderr); assert.match(cli.stdout, /Verified pinned Harness/);
  const help = invoke(['run', '--help']); assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /--bench/);
  const project = invoke(['project', '--help']); assert.equal(project.status, 0, project.stderr); assert.match(project.stdout, /init/); assert.match(project.stdout, /judge/);
  if (process.platform === 'win32') {
    const native = invoke(['run', '--bench', 'jb']); assert.equal(native.status, 1); assert.match(native.stderr, /require Linux/);
  }
});
