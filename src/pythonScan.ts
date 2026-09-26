import * as vscode from 'vscode';

/**
 * Deliberately regex-based, not a real parser. This is the spike's honest
 * demonstration of the resolution problem from the design doc: it finds
 * definitions reliably and call edges only approximately.
 */

export interface PySymbol {
  name: string;
  qualified: string;
  kind: 'function' | 'method' | 'class';
  startLine: number;   // 0-based, the def line
  endLine: number;     // 0-based, inclusive
  indent: number;
}

const DEF_RE = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/;
const CLASS_RE = /^(\s*)class\s+([A-Za-z_]\w*)/;

const NON_CALLS = new Set([
  'if', 'for', 'while', 'return', 'print', 'len', 'range', 'str', 'int', 'float',
  'dict', 'list', 'set', 'tuple', 'bool', 'sum', 'min', 'max', 'abs', 'round',
  'sorted', 'enumerate', 'zip', 'isinstance', 'super', 'open', 'type', 'and',
  'or', 'not', 'in', 'is', 'with', 'except', 'elif', 'assert', 'lambda', 'yield'
]);

export function scanSymbols(text: string): PySymbol[] {
  const lines = text.split(/\r?\n/);
  const out: PySymbol[] = [];
  let currentClass: { name: string; indent: number } | undefined;

  for (let i = 0; i < lines.length; i++) {
    const cls = CLASS_RE.exec(lines[i]);
    if (cls) {
      currentClass = { name: cls[2], indent: cls[1].length };
      continue;
    }
    const def = DEF_RE.exec(lines[i]);
    if (!def) { continue; }

    const indent = def[1].length;
    const name = def[2];
    if (currentClass && indent <= currentClass.indent) { currentClass = undefined; }
    const inClass = !!currentClass && indent > currentClass.indent;

    out.push({
      name,
      qualified: inClass ? `${currentClass!.name}.${name}` : name,
      kind: inClass ? 'method' : 'function',
      startLine: i,
      endLine: findEnd(lines, i, indent),
      indent
    });
  }
  return out;
}

function findEnd(lines: string[], defLine: number, indent: number): number {
  // A wrapped signature puts its closing `):` back at the def's own indent, so
  // scanning for a dedent immediately would end the symbol before its body
  // starts. Balance the parentheses first.
  let depth = 0;
  let cursor = defLine;
  do {
    const line = lines[cursor] ?? '';
    depth += (line.match(/\(/g) ?? []).length - (line.match(/\)/g) ?? []).length;
    cursor++;
  } while (depth > 0 && cursor < lines.length);

  for (let i = cursor; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) { continue; }
    const ind = l.length - l.trimStart().length;
    if (ind <= indent) { return i - 1; }
  }
  return lines.length - 1;
}

export function symbolAt(symbols: PySymbol[], line: number): PySymbol | undefined {
  // innermost wins, so a method beats its enclosing function
  let best: PySymbol | undefined;
  for (const s of symbols) {
    if (line >= s.startLine && line <= s.endLine) {
      if (!best || s.indent > best.indent) { best = s; }
    }
  }
  return best;
}

export interface RawCall { name: string; attribute?: string; line: number; }

/** Names called inside a symbol's body. Attribute calls are kept but flagged. */
export function callsInside(text: string, sym: PySymbol): RawCall[] {
  const lines = text.split(/\r?\n/);
  const seen = new Map<string, RawCall>();

  for (let i = sym.startLine + 1; i <= sym.endLine && i < lines.length; i++) {
    const line = lines[i].replace(/#.*$/, '');
    const re = /(?:([A-Za-z_]\w*)\s*\.\s*)?([A-Za-z_]\w*)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      const attribute = m[1];
      const name = m[2];
      if (NON_CALLS.has(name) || name === sym.name) { continue; }
      if (attribute === 'self' || attribute === 'cls') { continue; }
      const key = attribute ? `${attribute}.${name}` : name;
      if (!seen.has(key)) { seen.set(key, { name, attribute, line: i }); }
    }
  }
  return [...seen.values()];
}

export function relPath(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, false);
}
