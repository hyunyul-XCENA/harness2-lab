import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import type {AgentEvent, InputMessage, SessionCheckpoint, SessionState, SubmissionReceipt} from '../contracts/agent.js';
import {assertNoSymlink, id} from './util.js';

type Entry = {sessionId: string; sequence: number; time: string; kind: 'checkpoint' | 'input' | 'receipt' | 'event' | 'answer'; data: unknown};
export interface SavedInput extends InputMessage {status: SubmissionReceipt['status']; nativeTurnId?: string}

export class StateStore {
  private db: DatabaseSync;
  private lease?: string;
  private leaseDb?: DatabaseSync;
  private leasePath: string;
  private secrets = Object.entries(process.env).filter(([key, value]) => /API_KEY|AUTH_TOKEN|ACCESS_TOKEN|PASSWORD|SECRET/i.test(key) && value && value.length >= 6).map(([, value]) => value!);
  constructor(readonly directory: string) {
    assertNoSymlink(directory);
    fs.mkdirSync(directory, {recursive: true});
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('State directory must not be a symlink');
    this.leasePath = path.join(directory, 'active-session.lock');
    const database = path.join(directory, 'state.sqlite');
    if (fs.existsSync(database) && fs.lstatSync(database).isSymbolicLink()) throw new Error('State database must not be a symlink');
    this.db = new DatabaseSync(database);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, checkpoint TEXT, state TEXT NOT NULL DEFAULT 'opening', sequence INTEGER NOT NULL DEFAULT 0, updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inputs (request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, input TEXT NOT NULL, status TEXT NOT NULL, native_turn_id TEXT);`);
  }
  acquire(): void {
    if (this.lease) throw new Error('Session lease already held');
    // A SQLite OS lock provides crash-safe exclusion. The JSON file is only
    // diagnostic; stale PID files never authorize deleting another writer's lock.
    const leaseDatabase = path.join(this.directory, 'lease.sqlite');
    if (fs.existsSync(leaseDatabase) && fs.lstatSync(leaseDatabase).isSymbolicLink()) throw new Error('Invalid lease database');
    const lock = new DatabaseSync(leaseDatabase);
    try {lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');}
    catch {lock.close(); throw new Error('This project already has an active runner');}
    this.leaseDb = lock;
    const claim = JSON.stringify({pid: process.pid, nonce: id()});
    try {
      if (fs.existsSync(this.leasePath) && fs.lstatSync(this.leasePath).isSymbolicLink()) throw new Error('Invalid session lease');
      fs.writeFileSync(this.leasePath, claim, {mode: 0o600}); this.lease = claim; this.recover();
    } catch (error) {this.releaseLease(); throw error;}
  }
  private safeId(sessionId: string): void {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(sessionId)) throw new Error('Invalid application session ID');
  }
  private redact(value: unknown): unknown {
    return JSON.parse(JSON.stringify(value, (key, item: unknown) => {
      if (/^(apiKey|accessToken|authToken|password|secret)$/i.test(key)) return '[REDACTED]';
      if (typeof item === 'string') return this.secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), item);
      return item;
    }));
  }
  private apply(entry: Entry): void {
    this.db.prepare('INSERT OR IGNORE INTO sessions(id, updated) VALUES(?, ?)').run(entry.sessionId, entry.time);
    const current = this.db.prepare('SELECT sequence FROM sessions WHERE id=?').get(entry.sessionId) as {sequence: number};
    if (entry.sequence <= current.sequence) return;
    if (entry.kind === 'checkpoint') this.db.prepare('UPDATE sessions SET checkpoint=? WHERE id=?').run(JSON.stringify(entry.data), entry.sessionId);
    if (entry.kind === 'input') {
      const input = entry.data as InputMessage;
      this.db.prepare('INSERT OR IGNORE INTO inputs(request_id, session_id, input, status) VALUES(?,?,?,?)').run(input.requestId, entry.sessionId, JSON.stringify(input), 'queued');
    }
    if (entry.kind === 'receipt') {
      const receipt = entry.data as SubmissionReceipt;
      this.db.prepare('UPDATE inputs SET status=?, native_turn_id=COALESCE(?,native_turn_id) WHERE request_id=? AND session_id=?').run(receipt.status, receipt.nativeTurnId ?? null, receipt.requestId, entry.sessionId);
    }
    if (entry.kind === 'event') {
      const event = entry.data as AgentEvent;
      if (event.payload.type === 'state.changed') this.db.prepare('UPDATE sessions SET state=? WHERE id=?').run(event.payload.current, entry.sessionId);
    }
    this.db.prepare('UPDATE sessions SET sequence=?, updated=? WHERE id=?').run(entry.sequence, entry.time, entry.sessionId);
  }
  append(sessionId: string, kind: Entry['kind'], data: unknown): void {
    if (!this.lease) throw new Error('Session lease required');
    this.safeId(sessionId);
    const row = this.db.prepare('SELECT sequence FROM sessions WHERE id=?').get(sessionId) as {sequence: number} | undefined;
    const entry: Entry = {sessionId, sequence: (row?.sequence ?? 0) + 1, time: new Date().toISOString(), kind, data: this.redact(data)};
    if (kind === 'checkpoint') (entry.data as SessionCheckpoint).lastJournalSequence = entry.sequence;
    const dir = path.join(this.directory, 'sessions', sessionId);
    const root = path.dirname(dir);
    if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) throw new Error('Invalid journal root');
    fs.mkdirSync(dir, {recursive: true});
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('Invalid session directory');
    const journal = path.join(dir, 'events.jsonl');
    if (fs.existsSync(journal) && fs.lstatSync(journal).isSymbolicLink()) throw new Error('Invalid session journal');
    const fd = fs.openSync(journal, 'a', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(entry) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    this.db.exec('BEGIN IMMEDIATE');
    try { this.apply(entry); this.db.exec('COMMIT'); } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private recover(): void {
    const root = path.join(this.directory, 'sessions');
    if (!fs.existsSync(root)) return;
    if (fs.lstatSync(root).isSymbolicLink()) throw new Error('Invalid journal root');
    for (const name of fs.readdirSync(root)) {
      this.safeId(name);
      const journal = path.join(root, name, 'events.jsonl');
      if (!fs.existsSync(journal)) continue;
      if (fs.lstatSync(path.dirname(journal)).isSymbolicLink() || fs.lstatSync(journal).isSymbolicLink()) throw new Error('Invalid journal path');
      const bytes = fs.readFileSync(journal);
      const end = bytes.lastIndexOf(10) + 1;
      const lines = bytes.subarray(0, end).toString('utf8').split('\n').filter(Boolean);
      // Parse all complete records before changing either index or partial tail.
      const entries = lines.map((line, index) => {
        try {return JSON.parse(line) as Entry;}
        catch {throw new Error(`Corrupt journal: ${journal}, line ${index + 1}. Preserve the state directory and restore the record from backup before retrying.`);}
      });
      for (const [index, entry] of entries.entries()) {
        if (entry.sessionId !== name || entry.sequence !== index + 1 || !['checkpoint', 'input', 'receipt', 'event', 'answer'].includes(entry.kind)) throw new Error(`Invalid journal identity or sequence: ${journal}, line ${index + 1}. Preserve the state directory before repairing it.`);
      }
      for (const entry of entries) this.apply(entry);
      if (end < bytes.length) {
        fs.writeFileSync(`${journal}.partial-${id()}`, bytes.subarray(end), {flag: 'wx', mode: 0o600});
        fs.truncateSync(journal, end);
      }
    }
    // Sent/accepted work may have executed. Keep it unknown until explicitly reconciled.
    this.db.exec("UPDATE inputs SET status='unknown' WHERE status IN ('sent','accepted')");
  }
  checkpoint(sessionId: string): SessionCheckpoint {
    this.safeId(sessionId);
    const row = this.db.prepare('SELECT checkpoint FROM sessions WHERE id=?').get(sessionId) as {checkpoint: string | null} | undefined;
    if (!row?.checkpoint) throw new Error('No saved checkpoint for this session');
    return JSON.parse(row.checkpoint) as SessionCheckpoint;
  }
  inputs(sessionId: string): SavedInput[] {
    const rows = this.db.prepare('SELECT input,status,native_turn_id FROM inputs WHERE session_id=? ORDER BY rowid').all(sessionId) as {input: string; status: SavedInput['status']; native_turn_id: string | null}[];
    return rows.map(row => ({...JSON.parse(row.input) as InputMessage, status: row.status, ...(row.native_turn_id ? {nativeTurnId: row.native_turn_id} : {})}));
  }
  list(): {id: string; state: SessionState; updated: string}[] {
    return this.db.prepare('SELECT id,state,updated FROM sessions WHERE checkpoint IS NOT NULL ORDER BY updated DESC').all() as unknown as {id: string; state: SessionState; updated: string}[];
  }
  close(): void {
    try {this.db.close();} finally {this.releaseLease();}
  }
  private releaseLease(): void {
    try {
      if (this.lease && fs.existsSync(this.leasePath) && fs.readFileSync(this.leasePath, 'utf8') === this.lease) fs.unlinkSync(this.leasePath);
    } finally {this.lease = undefined; this.leaseDb?.close(); this.leaseDb = undefined;}
  }
}
