import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const load = relative => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const ajv = new Ajv2020({allErrors: true, strict: true});
const samples = [
  ['contracts/runner-config.schema.json', 'examples/runner.config.json'],
  ['contracts/runner-config.schema.json', 'examples/runner.claude.config.json'],
  ['contracts/harness.schema.json', 'examples/harnesses/coding-v1/manifest.json'],
];
for (const [schemaPath, samplePath] of samples) {
  const schema = load(schemaPath);
  const validate = ajv.getSchema(schema.$id) ?? ajv.compile(schema);
  assert(validate(load(samplePath)), `${samplePath}: ${ajv.errorsText(validate.errors)}`);
  console.log(`PASS ${samplePath}`);
}

const config = load('examples/runner.config.json');
const manifest = load('examples/harnesses/coding-v1/manifest.json');
assert.equal(config.runtime.harness, `project:${manifest.id}`);
const bundleRoot = fs.realpathSync(path.join(root, 'examples/harnesses/coding-v1'));
const paths = new Set();
for (const entry of manifest.files) {
  assert(!path.posix.isAbsolute(entry.path) && !path.win32.isAbsolute(entry.path));
  assert(!entry.path.split('/').some(segment => ['', '.', '..'].includes(segment)));
  assert(!paths.has(entry.path), `duplicate path: ${entry.path}`);
  paths.add(entry.path);
  let current = bundleRoot;
  for (const segment of entry.path.split('/')) {
    current = path.join(current, segment);
    assert(!fs.lstatSync(current).isSymbolicLink(), `symlink: ${entry.path}`);
  }
  const resolved = fs.realpathSync(current);
  const relative = path.relative(bundleRoot, resolved);
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  assert(fs.statSync(resolved).isFile());
}
console.log('PASS harness example file references');
