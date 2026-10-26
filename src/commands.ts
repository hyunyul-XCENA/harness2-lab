import type {SessionManager} from './session.js';
import {errorText, record} from './util.js';

export const help = `Terminal Runner 0.5 — chat prototype / pinned original Harness² engine
Original engine: npm start -- --harness2 demo --k 1 --mode both
Usage: npm start -- --project <directory> [--engine codex|claude] [--home <directory>] [--model <model>] [--resume <session-id>]
Options: --codex-path <executable>, --claude-path <executable>, --sessions, --select, --plain, --tui, --help
Interactive terminals use the full-screen UI. --plain keeps line input; pipes use plain mode.
Commands:
  ::help                     show runner commands
  ::interrupt                interrupt the current turn (Ctrl+C also works)
  ::steer <message>           add guidance to the active Codex turn
  ::allow <request-id>        approve once
  ::deny <request-id>         deny approval
  ::answer <request-id> <JSON> answer questions, e.g. {"language":"Korean"}
  ::history                  show input delivery states
  ::sessions                 close current connection and choose a session (TUI)
  ::ack-unknown              acknowledge unknown delivery; never resends it
  ::quit                     close the runner, preserving the native thread
Runner commands use ::. Native / commands need the native CLI UI; this SDK/App Server chat does not execute them.
TUI: F2 review pending request, PgUp/PgDn scroll, Esc return, Up/Down input history.
Normal input starts a turn. During a turn, one message can be queued.
Claude follow-ups queue until the current turn ends. Chat turns do not run Harness² automatically; use --harness2 for the original method.`;

export interface Commands {
  manager: SessionManager;
  note(text: string): void;
  quit(): Promise<void>;
  sessions(): Promise<void>;
}
/** Native submit is intentionally not awaited: approvals and interrupts stay usable. */
export async function command(input: string, context: Commands): Promise<void> {
  const text = input.trim(); if (!text) return;
  const split = text.search(/\s/), name = split < 0 ? text : text.slice(0, split), args = split < 0 ? '' : text.slice(split).trim();
  const {manager, note} = context;
  const submit = (steer = false) => {void manager.input(steer ? args : text, steer).catch(error => note(`[error] ${errorText(error)}`));};
  if (name === '::quit') await context.quit();
  else if (name === '::sessions') await context.sessions();
  else if (name === '::help') note(help);
  else if (name === '::interrupt') await manager.interrupt();
  else if (name === '::steer') submit(true);
  else if (name === '::allow' || name === '::deny') await manager.answer(args, {kind: 'approval', decision: name === '::allow' ? 'allow-once' : 'deny'});
  else if (name === '::answer') {
    const space = args.search(/\s/); if (space < 0) throw new Error('::answer <request-id> {"question-id":"answer"}');
    const answers = record(JSON.parse(args.slice(space).trim()));
    if (Object.values(answers).some(value => typeof value !== 'string')) throw new Error('Each answer must be a string');
    await manager.answer(args.slice(0, space), {kind: 'question', answers: answers as Record<string, string>});
  } else if (name === '::history') note(manager.history().map(value => `${value.status} ${value.requestId}\n${value.text}\n${value.nativeTurnId ?? ''}`).join('\n\n') || 'No inputs yet.');
  else if (name === '::ack-unknown') {manager.acknowledgeUnknown(); note('Acknowledged. Previous input was not resent.');}
  else if (name.startsWith('::')) throw new Error('Unknown runner command; use ::help');
  else if (name.startsWith('/')) throw new Error('Native / commands require the native Codex/Claude CLI UI. This SDK/App Server chat cannot execute them. Runner commands use ::help.');
  else submit();
}
