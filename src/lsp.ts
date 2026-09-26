import * as vscode from 'vscode';
import { SymbolRef } from './types';
import { CodeSymbol, LanguagePack } from './lang/types';

/**
 * The language-server layer: the part of the product that is genuinely
 * language-agnostic.
 *
 * Whatever language extension the user has installed — Pylance, gopls, the
 * TypeScript server, rust-analyzer — answers the editor's built-in navigation
 * commands. Those answers come from a type checker, so they are the real call
 * graph rather than a name match: exactly what the regex index can't do.
 *
 * Every call here is bounded and optional. No server, a slow server or an
 * empty answer returns `undefined`, and the caller falls back to the index.
 */

const TIMEOUT_MS = 4000;
let channel: vscode.OutputChannel | undefined;

/** A trace of which source answered, so a wrong caller list can be diagnosed. */
export function log(message: string): void {
  channel ??= vscode.window.createOutputChannel('Code Context');
  channel.appendLine(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
}

async function bounded<T>(work: Thenable<T>, what: string): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(work),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          log(`${what}: no answer within ${TIMEOUT_MS} ms, using the index`);
          resolve(undefined);
        }, TIMEOUT_MS);
      })
    ]);
  } catch (err) {
    log(`${what}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The position of the symbol's name on its definition line — what servers key on. */
export function namePosition(doc: vscode.TextDocument, sym: CodeSymbol): vscode.Position {
  const text = doc.lineAt(Math.min(sym.startLine, doc.lineCount - 1)).text;
  // For a Go method the receiver comes first — `func (h *Handler) GetUser(` —
  // so take the occurrence followed by an opening bracket where there is one.
  const called = new RegExp(`\\b${escapeRe(sym.name)}\\b(?=\\s*[(\\[<])`).exec(text);
  const any = new RegExp(`\\b${escapeRe(sym.name)}\\b`).exec(text);
  const at = called ?? any;
  return new vscode.Position(sym.startLine, at ? at.index : 0);
}

function inWorkspace(uri: vscode.Uri): boolean {
  return uri.scheme === 'file' && !!vscode.workspace.getWorkspaceFolder(uri);
}

/** `(*Handler).GetUser` (gopls), `GetUser()` and `get_user` all become a plain name. */
function cleanName(raw: string): { name: string; qualified: string } {
  const goMethod = /^\(\*?(\w+)\)\.(\w+)$/.exec(raw);
  if (goMethod) {
    return { name: goMethod[2], qualified: `${goMethod[1]}.${goMethod[2]}` };
  }
  const name = raw.replace(/\(.*\)$/, '').trim();
  return { name: name.split('.').pop() ?? name, qualified: name };
}

/** Symbols from the language server, for languages that have no pack. */
export async function lspDocumentSymbols(doc: vscode.TextDocument): Promise<CodeSymbol[] | undefined> {
  const result = await bounded(
    vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>(
      'vscode.executeDocumentSymbolProvider',
      doc.uri
    ),
    'document symbols'
  );
  if (!result?.length) {
    return undefined;
  }
  const out: CodeSymbol[] = [];
  const kindOf = (k: vscode.SymbolKind): CodeSymbol['kind'] | undefined =>
    k === vscode.SymbolKind.Function ? 'function'
    : k === vscode.SymbolKind.Method || k === vscode.SymbolKind.Constructor ? 'method'
    : k === vscode.SymbolKind.Class || k === vscode.SymbolKind.Struct || k === vscode.SymbolKind.Interface ? 'class'
    : undefined;

  const walk = (items: vscode.DocumentSymbol[], parents: string[], depth: number) => {
    for (const s of items) {
      const kind = kindOf(s.kind);
      const { name, qualified } = cleanName(s.name);
      if (kind) {
        out.push({
          name,
          qualified: parents.length && kind === 'method' && !qualified.includes('.') ? `${parents.join('.')}.${name}` : qualified,
          kind,
          startLine: s.range.start.line,
          endLine: s.range.end.line,
          indent: depth
        });
      }
      walk(s.children ?? [], kind === 'class' ? [...parents, name] : parents, depth + 1);
    }
  };
  if ('children' in result[0]) {
    walk(result as vscode.DocumentSymbol[], [], 0);
  } else {
    for (const s of result as vscode.SymbolInformation[]) {
      const kind = kindOf(s.kind);
      if (kind) {
        const { name, qualified } = cleanName(s.name);
        out.push({ name, qualified, kind, startLine: s.location.range.start.line, endLine: s.location.range.end.line, indent: 0 });
      }
    }
  }
  return out.length ? out : undefined;
}

export interface CallerContext {
  pack?: LanguagePack;
  /** Symbols of a workspace file, from the index when it has them. */
  symbolsOf(uri: vscode.Uri): Promise<{ rel: string; text: string; symbols: CodeSymbol[] } | undefined>;
  moduleLabel(rel: string): string;
}

/**
 * Callers from the reference provider. References rather than the call
 * hierarchy, because a function is used in two ways and framework code is full
 * of the one without a call: `Depends(get_db)`, `r.GET("/x", h.GetUser)`.
 */
export async function lspCallers(
  doc: vscode.TextDocument,
  sym: CodeSymbol,
  ctx: CallerContext
): Promise<SymbolRef[] | undefined> {
  const pos = namePosition(doc, sym);
  const locations = await bounded(
    vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', doc.uri, pos),
    `references to ${sym.name}`
  );
  if (!locations?.length) {
    return undefined; // no server, or an empty answer — both mean "ask the index"
  }

  const out: SymbolRef[] = [];
  for (const loc of locations.slice(0, 80)) {
    if (!inWorkspace(loc.uri)) {
      continue;
    }
    const line = loc.range.start.line;
    if (loc.uri.toString() === doc.uri.toString() && line === pos.line) {
      continue; // the definition itself
    }
    const file = await ctx.symbolsOf(loc.uri);
    if (!file) {
      continue;
    }
    const text = file.text.split(/\r?\n/)[line] ?? '';
    if (ctx.pack && (ctx.pack.isImportLine(text) || ctx.pack.isDefinitionLine(text, sym.name))) {
      continue;
    }
    const after = text.slice(loc.range.end.character);
    const kind: 'call' | 'reference' = /^\s*[(<[]/.test(after) ? 'call' : 'reference';

    let enclosing: CodeSymbol | undefined;
    for (const s of file.symbols) {
      if (line >= s.startLine && line <= s.endLine && s.kind !== 'class' && (!enclosing || s.indent >= enclosing.indent)) {
        enclosing = s;
      }
    }
    const base = ctx.moduleLabel(file.rel);
    const ref: SymbolRef = {
      name: enclosing ? enclosing.name : base,
      qualified: enclosing ? `${base}.${enclosing.qualified}` : `${base} (top level)`,
      file: file.rel,
      line: enclosing ? enclosing.startLine : line,
      kind,
      confidence: 'resolved',
      reason: `language server${kind === 'reference' ? ' — passed as a reference, not called' : ''}`
    };
    if (!out.some((r) => r.file === ref.file && r.qualified === ref.qualified)) {
      out.push(ref);
    }
  }
  log(`callers of ${sym.qualified}: ${out.length} from the language server`);
  return out;
}

/** Where a definition outside the workspace lives, in words a reader recognises. */
function libraryOf(uri: vscode.Uri, detail?: string): string {
  const p = uri.path;
  let m: RegExpExecArray | null;
  if ((m = /site-packages\/([^/]+)/.exec(p))) {
    return m[1].replace(/\.py$/, '');
  }
  if ((m = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(p))) {
    return m[1];
  }
  if ((m = /pkg\/mod\/(.+?)@[^/]+/.exec(p))) {
    return m[1];
  }
  if ((m = /\/go\/src\/(.+)\/[^/]+\.go$/.exec(p))) {
    return m[1];
  }
  if ((m = /typeshed\/stdlib\/(.+?)(?:\/__init__)?\.pyi$/.exec(p))) {
    return m[1].replace(/\//g, '.');
  }
  return detail || p.split('/').slice(-2, -1)[0] || 'a library';
}

/** Callees from the call hierarchy: what this function calls, resolved by the server. */
export async function lspCallees(
  doc: vscode.TextDocument,
  sym: CodeSymbol,
  relOf: (uri: vscode.Uri) => string
): Promise<SymbolRef[] | undefined> {
  const pos = namePosition(doc, sym);
  const items = await bounded(
    vscode.commands.executeCommand<vscode.CallHierarchyItem[]>('vscode.prepareCallHierarchy', doc.uri, pos),
    `call hierarchy for ${sym.name}`
  );
  if (!items?.length) {
    return undefined;
  }
  const calls = await bounded(
    vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>('vscode.provideOutgoingCalls', items[0]),
    `calls made by ${sym.name}`
  );
  if (!calls) {
    return undefined;
  }
  const out: SymbolRef[] = [];
  for (const call of calls) {
    const { name, qualified } = cleanName(call.to.name);
    if (name === sym.name && call.to.uri.toString() === doc.uri.toString()) {
      continue;
    }
    const ref: SymbolRef = inWorkspace(call.to.uri)
      ? {
          name,
          qualified,
          file: relOf(call.to.uri),
          line: call.to.range.start.line,
          confidence: 'resolved',
          reason: 'language server'
        }
      : {
          name,
          qualified,
          file: '',
          line: -1,
          confidence: 'external',
          reason: `from ${libraryOf(call.to.uri, call.to.detail)}`
        };
    if (!out.some((r) => r.qualified === ref.qualified && r.file === ref.file)) {
      out.push(ref);
    }
  }
  log(`calls made by ${sym.qualified}: ${out.length} from the language server`);
  return out;
}
