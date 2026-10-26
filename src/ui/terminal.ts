import {StringDecoder} from 'node:string_decoder';
import {stripVTControlCharacters} from 'node:util';
import stringWidth from 'string-width';

const segmenter = new Intl.Segmenter(undefined, {granularity: 'grapheme'});
export const graphemes = (text: string): string[] => [...segmenter.segment(text)].map(part => part.segment);
export const width = stringWidth;
/** Sanitize whole accumulated messages, including escapes split across deltas. */
export const clean = (text: string): string => stripVTControlCharacters(text).replace(/\r\n?/g, '\n').replace(/\t/g, '    ').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '');

export function clip(text: string, columns: number): string {
  let result = '', used = 0;
  for (const part of graphemes(clean(text).replace(/\n/g, ' '))) {
    const size = width(part); if (used + size > columns) break;
    result += part; used += size;
  }
  return result;
}
export function wrap(text: string, columns: number): string[] {
  const lines: string[] = []; let line = '', used = 0;
  for (const part of graphemes(clean(text))) {
    if (part === '\n') {lines.push(line); line = ''; used = 0; continue;}
    const size = width(part);
    if (used + size > columns) {lines.push(line); line = ''; used = 0;}
    if (size <= columns) {line += part; used += size;}
  }
  lines.push(line); return lines;
}

export type Key = {name: string; text?: string};
const sequences: Record<string, string> = {
  '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left',
  '\x1b[H': 'home', '\x1b[F': 'end', '\x1bOH': 'home', '\x1bOF': 'end',
  '\x1b[1~': 'home', '\x1b[4~': 'end', '\x1b[3~': 'delete',
  '\x1b[5~': 'pageup', '\x1b[6~': 'pagedown', '\x1bOQ': 'f2', '\x1b[12~': 'f2',
  '\x1b[200~': 'paste',
};
/** Own parser keeps bracketed paste atomic: pasted newlines never run commands. */
export class KeyDecoder {
  private decoder = new StringDecoder('utf8');
  private buffer = '';
  private paste?: string;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private emit: (key: Key) => void) {}
  push(chunk: Buffer | string): void {this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk); this.parse();}
  private parse(): void {
    clearTimeout(this.timer);
    while (this.buffer) {
      if (this.paste !== undefined) {
        const end = this.buffer.indexOf('\x1b[201~');
        if (end < 0) {
          // Keep a possible split closing marker. Bound an unclosed paste to 1 MiB.
          const keep = Math.min(5, this.buffer.length);
          this.paste = (this.paste + this.buffer.slice(0, -keep)).slice(0, 1024 * 1024);
          this.buffer = this.buffer.slice(-keep); return;
        }
        const text = clean((this.paste + this.buffer.slice(0, end)).slice(0, 1024 * 1024));
        this.paste = undefined; this.buffer = this.buffer.slice(end + 6); this.emit({name: 'paste', text}); continue;
      }
      if (this.buffer[0] === '\x1b') {
        const sequence = Object.keys(sequences).find(value => this.buffer.startsWith(value));
        if (sequence) {
          this.buffer = this.buffer.slice(sequence.length);
          if (sequences[sequence] === 'paste') this.paste = ''; else this.emit({name: sequences[sequence]!});
          continue;
        }
        if (Object.keys(sequences).some(value => value.startsWith(this.buffer)) || this.buffer === '\x1b') {
          this.timer = setTimeout(() => {this.buffer = ''; this.emit({name: 'escape'});}, 80); return;
        }
        // Ignore unknown complete CSI/SS3/OSC, never insert their bytes as text.
        const unknown = this.buffer.match(/^\x1b(?:\[[0-?]*[ -/]*[@-~]|O.|\][^\x07]*(?:\x07|\x1b\\))/);
        if (unknown) {this.buffer = this.buffer.slice(unknown[0].length); continue;}
        if (/^\x1b[\[\]O]/.test(this.buffer) && this.buffer.length < 256) {
          this.timer = setTimeout(() => {this.buffer = '';}, 80); return;
        }
        this.buffer = this.buffer.slice(1); this.emit({name: 'escape'}); continue;
      }
      const point = String.fromCodePoint(this.buffer.codePointAt(0)!); this.buffer = this.buffer.slice(point.length);
      const special: Record<string, string> = {'\r': 'enter', '\n': 'enter', '\x03': 'interrupt', '\x04': 'eof', '\x01': 'home', '\x05': 'end', '\x15': 'clear', '\x0c': 'redraw', '\x08': 'backspace', '\x7f': 'backspace', '\t': 'tab'};
      if (special[point]) this.emit({name: special[point]!});
      else if (point >= ' ' && !/[\x7f-\x9f]/.test(point)) this.emit({name: 'text', text: point});
    }
  }
  close(): void {clearTimeout(this.timer); this.buffer = '';}
}

export class Editor {
  text = '';
  cursor = 0; // UTF-16 offset, always a grapheme boundary after editing.
  private history: string[] = [];
  private historyIndex?: number;
  private draft = '';
  set(text: string): void {this.text = text; this.cursor = text.length;}
  take(): string {const text = this.text; if (text.trim()) this.history.push(text); this.historyIndex = undefined; this.set(''); return text;}
  key(key: Key): void {
    const left = graphemes(this.text.slice(0, this.cursor)), right = graphemes(this.text.slice(this.cursor));
    if (key.name === 'text' || key.name === 'paste') {
      const text = clean(key.text ?? '');
      if (this.text.length + text.length > 1024 * 1024) return;
      this.text = this.text.slice(0, this.cursor) + text + this.text.slice(this.cursor); this.cursor += text.length;
      // A combining mark/ZWJ may join the right-hand grapheme after insertion.
      const boundaries = [...segmenter.segment(this.text)].map(part => part.index + part.segment.length);
      this.cursor = boundaries.find(index => index >= this.cursor) ?? this.text.length;
    } else if (key.name === 'left') this.cursor -= left.at(-1)?.length ?? 0;
    else if (key.name === 'right') this.cursor += right[0]?.length ?? 0;
    else if (key.name === 'home') this.cursor = 0;
    else if (key.name === 'end') this.cursor = this.text.length;
    else if (key.name === 'clear') this.set('');
    else if (key.name === 'backspace') {const size = left.at(-1)?.length ?? 0; this.text = this.text.slice(0, this.cursor - size) + this.text.slice(this.cursor); this.cursor -= size;}
    else if (key.name === 'delete') this.text = this.text.slice(0, this.cursor) + this.text.slice(this.cursor + (right[0]?.length ?? 0));
    else if (key.name === 'up' && this.history.length) {
      if (this.historyIndex === undefined) {this.draft = this.text; this.historyIndex = this.history.length;}
      this.historyIndex = Math.max(0, this.historyIndex - 1); this.set(this.history[this.historyIndex]!);
    } else if (key.name === 'down' && this.historyIndex !== undefined) {
      this.historyIndex++;
      if (this.historyIndex >= this.history.length) {this.set(this.draft); this.historyIndex = undefined;}
      else this.set(this.history[this.historyIndex]!);
    }
  }
  view(columns: number): {text: string; cursor: number} {
    const before = graphemes(this.text.slice(0, this.cursor).replace(/\n/g, '↵'));
    let visible = '', used = 0;
    for (const part of before.reverse()) {if (used + width(part) > columns - 1) break; visible = part + visible; used += width(part);}
    return {text: clip(visible + this.text.slice(this.cursor).replace(/\n/g, '↵'), columns), cursor: used};
  }
}

export interface TerminalInput extends NodeJS.ReadStream {}
export interface TerminalOutput extends NodeJS.WriteStream {}
/** Owns only terminal modes/listeners; close restores the caller's raw/flow state. */
export class Screen {
  private decoder: KeyDecoder;
  private raw: boolean;
  private paused: boolean;
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private onData = (data: Buffer | string) => this.decoder.push(data);
  private onResize = () => this.invalidate();
  constructor(readonly input: TerminalInput, readonly output: TerminalOutput, private onKey: (key: Key) => void, private draw: () => {lines: string[]; cursor?: {row: number; column: number}}) {
    this.decoder = new KeyDecoder(key => this.onKey(key)); this.raw = !!input.isRaw; this.paused = input.readableFlowing !== true;
    input.setRawMode(true); input.on('data', this.onData); input.resume(); output.on('resize', this.onResize);
    output.write('\x1b[?1049h\x1b[?25l\x1b[?2004h'); this.invalidate();
  }
  get columns(): number {return Math.max(1, (this.output.columns || 80) - 1);}
  get rows(): number {return Math.max(1, this.output.rows || 24);}
  /** Change views without reopening Windows ReadConsole or dropping its next read. */
  setView(onKey: (key: Key) => void, draw: () => {lines: string[]; cursor?: {row: number; column: number}}): void {
    this.onKey = onKey; this.draw = draw; this.invalidate();
  }
  invalidate(): void {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {this.timer = undefined; this.paint();}, 33);
  }
  paint(): void {
    if (this.closed) return;
    const {lines, cursor} = this.draw();
    let frame = '\x1b[?25l\x1b[H';
    for (let row = 0; row < this.rows; row++) frame += `\x1b[${row + 1};1H\x1b[2K${clip(lines[row] ?? '', this.columns)}`;
    if (cursor && cursor.row <= this.rows) frame += `\x1b[${cursor.row};${Math.min(this.columns, cursor.column)}H\x1b[?25h`;
    this.output.write(frame);
  }
  close(): void {
    if (this.closed) return; this.closed = true; clearTimeout(this.timer); this.decoder.close();
    this.input.removeListener('data', this.onData); this.output.removeListener('resize', this.onResize);
    this.input.setRawMode(this.raw); if (this.paused) this.input.pause();
    this.output.write('\x1b[?2004l\x1b[?25h\x1b[?1049l');
  }
}
