import { CodeSymbol, LanguagePack, RawCall, Resolution, ScannedFile } from './types';
import { buildGoWorkflow } from './goWorkflow';
import { scanGoEntryPoints } from './goEntryPoints';
import { goImports, maskGo } from './goSyntax';

export { goImports, maskGo };

/**
 * Go.
 *
 * Symbols by `func`, methods by their receiver (`func (s *Server) Start`), types
 * by `type X struct|interface`, bodies by brace matching. Resolution follows the
 * language's own rules, which are stricter than Python's and so worth more:
 * a package is a directory, code in the same package refers to a name bare,
 * code elsewhere must write `pkg.Name` through an import, and a lowercase name
 * cannot be seen outside its package at all.
 */

const KEYWORDS = new Set([
  'if', 'for', 'switch', 'select', 'return', 'func', 'go', 'defer', 'range', 'case', 'default',
  'map', 'chan', 'struct', 'interface', 'else', 'var', 'const', 'type', 'package', 'import'
]);
const BUILTINS = new Set([
  'append', 'cap', 'clear', 'close', 'complex', 'copy', 'delete', 'imag', 'len', 'make', 'max',
  'min', 'new', 'panic', 'print', 'println', 'real', 'recover',
  'string', 'int', 'int8', 'int16', 'int32', 'int64', 'uint', 'uint8', 'uint16', 'uint32',
  'uint64', 'uintptr', 'byte', 'rune', 'float32', 'float64', 'bool', 'error', 'any',
  'complex64', 'complex128'
]);

const FUNC_RE =
  /^func\s+(?:\(\s*(?:[A-Za-z_]\w*\s+)?\*?\s*([A-Za-z_]\w*)(?:\[[^\]]*\])?\s*\)\s*)?([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*\(/;
const TYPE_RE = /^type\s+([A-Za-z_]\w*)(?:\[[^\]]*\])?\s+(struct|interface)\b/;

/**
 * The line a declaration's body closes on. The body's `{` is the first one at
 * parenthesis depth zero that isn't an inline `struct{}` or `interface{}` in the
 * signature. Declarations without a body end where they start.
 */
function bodyEnd(masked: string[], start: number): number {
  let paren = 0;
  let depth = 0;
  let open = false;
  for (let i = start; i < masked.length; i++) {
    const line = masked[i];
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (!open) {
        if (ch === '(') {
          paren++;
        } else if (ch === ')') {
          paren--;
        } else if (ch === '{' && paren === 0) {
          const before = line.slice(0, j).trimEnd();
          const after = line.slice(j + 1).trimStart();
          if (/\b(struct|interface)$/.test(before) && after.startsWith('}')) {
            j = line.indexOf('}', j); // `interface{}` in a return type, not the body
            continue;
          }
          open = true;
          depth = 1;
        }
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) {
          return i;
        }
      }
    }
    // A signature line with no brace and balanced parens that ends a statement
    // is a declaration without a body (an interface-free forward, or assembly).
    if (!open && paren === 0 && i > start && !/[,(]\s*$/.test(line)) {
      return start;
    }
  }
  return open ? masked.length - 1 : start;
}

export function scanGoSymbols(text: string): CodeSymbol[] {
  const masked = maskGo(text).split(/\r?\n/);
  const out: CodeSymbol[] = [];
  for (let i = 0; i < masked.length; i++) {
    const line = masked[i];
    const fn = FUNC_RE.exec(line);
    if (fn) {
      const [, receiver, name] = fn;
      out.push({
        name,
        qualified: receiver ? `${receiver}.${name}` : name,
        kind: receiver ? 'method' : 'function',
        startLine: i,
        endLine: bodyEnd(masked, i),
        indent: 0
      });
      continue;
    }
    const ty = TYPE_RE.exec(line);
    if (ty) {
      out.push({ name: ty[1], qualified: ty[1], kind: 'class', startLine: i, endLine: bodyEnd(masked, i), indent: 0 });
    }
  }
  return out;
}

export function goCallsInside(text: string, sym: CodeSymbol): RawCall[] {
  const masked = maskGo(text).split(/\r?\n/);
  const seen = new Map<string, RawCall>();
  for (let i = sym.startLine; i <= sym.endLine && i < masked.length; i++) {
    // Skip the signature itself; its parameter types look like calls.
    const line = i === sym.startLine ? masked[i].slice(masked[i].indexOf('{') + 1 || masked[i].length) : masked[i];
    const re = /(?:([A-Za-z_]\w*)\s*\.\s*)?([A-Za-z_]\w*)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      const [, attribute, name] = m;
      if (KEYWORDS.has(name) || (!attribute && BUILTINS.has(name)) || name === sym.name) {
        continue;
      }
      const key = attribute ? `${attribute}.${name}` : name;
      if (!seen.has(key)) {
        seen.set(key, { name, attribute, line: i });
      }
    }
  }
  return [...seen.values()];
}

function dirOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i === -1 ? '' : rel.slice(0, i);
}

/** Does this import path point at that workspace directory? Module prefixes vary, the tail doesn't. */
function importPointsAt(importPath: string, dir: string): boolean {
  return !!dir && (importPath === dir || importPath.endsWith(`/${dir}`));
}

/** The line with a trailing `//` comment removed, ignoring `//` inside strings. */
function stripGoComment(line: string): string {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\' && quote !== '`') {
        i++;
      } else if (c === quote) {
        quote = undefined;
      }
    } else if (c === '"' || c === '`' || c === '\'') {
      quote = c;
    } else if (c === '/' && line[i + 1] === '/') {
      return line.slice(0, i);
    }
  }
  return line;
}

export const go: LanguagePack = {
  id: 'go',
  languageIds: ['go'],
  extensions: ['.go'],
  excludeDirs: ['vendor', 'testdata'],

  scanSymbols: scanGoSymbols,
  callsInside: goCallsInside,

  stripComment: stripGoComment,
  isImportLine: (line) => /^\s*import\b/.test(line) || /^\s*(?:[\w.]+\s+)?"[^"]*"\s*$/.test(line),
  isDefinitionLine: (line, name) =>
    new RegExp(`^\\s*func\\s+(?:\\([^)]*\\)\\s*)?${name}\\b|^\\s*type\\s+${name}\\b`).test(line),

  resolve(file: ScannedFile, defRel: string, target: CodeSymbol, line: string): Resolution {
    if (file.rel === defRel) {
      return 'resolved';
    }
    const samePackage = dirOf(file.rel) === dirOf(defRel);
    const exported = /^[A-Z]/.test(target.name);
    if (!exported && !samePackage) {
      return 'skip'; // a lowercase name is invisible outside its package
    }
    if (target.kind === 'method') {
      // `x.Name(` could be any type with a method of that name; only the type
      // checker knows which. Honest answer: a guess.
      return new RegExp(`\\.\\s*${target.name}\\b`).test(line) ? 'heuristic' : 'skip';
    }
    const qualified = new RegExp(`(\\w+)\\s*\\.\\s*${target.name}\\b`).exec(line);
    const bare = new RegExp(`(^|[^.\\w])${target.name}\\b`).test(line);
    if (samePackage) {
      return bare ? 'resolved' : 'skip'; // `x.Name` in its own package is something else
    }
    if (!qualified) {
      return 'skip'; // another package can't refer to it without a qualifier
    }
    const path = goImports(file.text).get(qualified[1]);
    if (!path) {
      return 'skip'; // qualified by a variable, not a package: a method of that name
    }
    return importPointsAt(path, dirOf(defRel)) ? 'resolved' : dirOf(defRel) ? 'skip' : 'heuristic';
  },

  importSourceOf(text: string, call: RawCall): string | undefined {
    return call.attribute ? goImports(text).get(call.attribute) : undefined;
  },

  moduleLabel: (rel) => {
    const dir = dirOf(rel);
    return dir ? dir.split('/').pop()! : (rel.split('/').pop() ?? rel).replace(/\.go$/, '');
  },
  isTestFile: (rel) => /_test\.go$/.test(rel),

  importedFiles(file: ScannedFile, files: ScannedFile[]): ScannedFile[] {
    const dirs = new Map<string, ScannedFile>();
    for (const f of files) {
      if (!dirs.has(dirOf(f.rel))) {
        dirs.set(dirOf(f.rel), f);
      }
    }
    const out: ScannedFile[] = [];
    for (const path of goImports(file.text).values()) {
      // The longest workspace directory the import path ends with.
      let best: string | undefined;
      for (const dir of dirs.keys()) {
        if (importPointsAt(path, dir) && (!best || dir.length > best.length)) {
          best = dir;
        }
      }
      if (best !== undefined) {
        out.push(dirs.get(best)!);
      }
    }
    return out;
  },

  buildWorkflow: buildGoWorkflow,
  scanEntryPoints: scanGoEntryPoints
};
