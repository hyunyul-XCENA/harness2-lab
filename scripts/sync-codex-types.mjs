// Copy only the generated parameter-type closure; adapt extensionless imports for ESM.
import fs from 'node:fs';
import path from 'node:path';
const source = path.resolve(process.argv[2] ?? '../.tools/codex-protocol-0.163.0');
const target = path.resolve('src/adapters/codex-protocol');
const roots = ['InitializeParams.ts', 'v2/ThreadStartParams.ts', 'v2/ThreadResumeParams.ts', 'v2/TurnStartParams.ts', 'v2/TurnSteerParams.ts', 'v2/CommandExecutionRequestApprovalResponse.ts', 'v2/FileChangeRequestApprovalResponse.ts', 'v2/ToolRequestUserInputResponse.ts'];
const seen = new Set();
function copy(relative) {
  if (seen.has(relative)) return;
  seen.add(relative);
  const input = fs.readFileSync(path.join(source, relative), 'utf8');
  const output = input.replace(/from "([^"\n]+)"/g, (_, specifier) => {
    if (!specifier.startsWith('.')) throw new Error('Unexpected generated import');
    copy(path.normalize(path.join(path.dirname(relative), specifier + '.ts')));
    return `from "${specifier}.js"`;
  });
  fs.mkdirSync(path.dirname(path.join(target, relative)), {recursive: true});
  fs.writeFileSync(path.join(target, relative), output);
}
roots.forEach(copy);
console.log(`Copied ${seen.size} generated parameter types from Codex CLI 0.163.0`);
