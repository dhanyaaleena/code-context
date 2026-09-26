import * as vscode from 'vscode';
import * as path from 'path';
import { ContextResponse, EntryPoint, FeatureContext, SymbolRef, Workflow } from './types';
import { relPath, symbolAt } from './pythonScan';
import { coChangedFiles, headSha, isDirty, repoRootFor, symbolAuthors, symbolHistory } from './git';
import { describeEntry } from './entryPoints';
import { CodeSymbol, EntryPointIndex, LanguagePack, entryKey } from './lang/types';
import { packForLanguage, packForPath } from './lang';
import { lspCallees, lspCallers } from './lsp';

import { FileIndex, ensureIndex, filesMentioning } from './repoIndex';

async function indexWorkspace(): Promise<FileIndex[]> {
  return (await ensureIndex()).files;
}

async function entryIndex(): Promise<EntryPointIndex> {
  return (await ensureIndex()).entries;
}

/**
 * Caller resolution by name — the fallback when no language server answers.
 *
 * resolved  — the use is in the defining file, or the language's import rules prove it
 * heuristic — the name matches and nothing rules it out, but nothing proves it either
 *
 * Each language decides what counts as proof: an import for Python, a package
 * qualifier for Go. Keeping the guesswork visible is the point.
 */
async function findCallersByName(target: CodeSymbol, defRel: string, pack: LanguagePack): Promise<SymbolRef[]> {
  // Only files that mention the name at all can possibly call it. This is the
  // difference between reading the whole corpus per lookup and reading four files.
  const files = (await filesMentioning(target.name)).filter((f) => f.lang === pack.id);
  const out: SymbolRef[] = [];

  // A function is "used" in two different ways, and only one of them has a paren
  // after it. Framework code is full of the other kind — Depends(fn), @app.get(fn),
  // register(fn), r.GET("/x", h.Handler) — so matching only `name(` loses them.
  const refRe = new RegExp(`\\b${target.name}\\b`);
  const callRe = new RegExp(`\\b${target.name}\\s*\\(`);

  for (const f of files) {
    const lines = f.text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = pack.stripComment(lines[i]);
      if (!refRe.test(line)) {
        continue;
      }
      if (f.rel === defRel && i === target.startLine) {
        continue; // the definition itself
      }
      if (pack.isImportLine(line) || pack.isDefinitionLine(line, target.name)) {
        continue; // an import, or a different definition of the same name
      }
      const resolution = pack.resolve(f, defRel, target, line);
      if (resolution === 'skip') {
        continue; // the language's rules say this can't be the target
      }

      const kind: 'call' | 'reference' = callRe.test(line) ? 'call' : 'reference';
      const enclosing = symbolAt(f.symbols, i);
      const base = pack.moduleLabel(f.rel);
      const ref: SymbolRef = {
        name: enclosing ? enclosing.name : base,
        qualified: enclosing ? `${base}.${enclosing.qualified}` : `${base} (top level)`,
        file: f.rel,
        line: enclosing ? enclosing.startLine : i,
        kind,
        confidence: resolution,
        reason:
          (kind === 'reference' ? 'passed as a reference, not called — ' : '') +
          (resolution === 'resolved'
            ? f.rel === defRel
              ? 'same file'
              : 'proved by imports'
            : 'name matches, nothing proves it')
      };
      if (!out.some((r) => r.file === ref.file && r.qualified === ref.qualified)) {
        out.push(ref);
      }
    }
  }
  return out;
}

/** Callers by name, for walks and counts where a server round-trip per hop is too slow. */
async function findCallers(target: CodeSymbol, defRel: string): Promise<SymbolRef[]> {
  const pack = packForPath(defRel);
  return pack ? findCallersByName(target, defRel, pack) : [];
}

async function resolveCalleesByName(
  text: string,
  sym: CodeSymbol,
  defRel: string,
  pack: LanguagePack
): Promise<SymbolRef[]> {
  const files = (await indexWorkspace()).filter((f) => f.lang === pack.id);
  const raw = pack.callsInside(text, sym);
  const out: SymbolRef[] = [];

  for (const call of raw) {
    const here = files.find((f) => f.rel === defRel);
    const local = here?.symbols.find((s) => s.name === call.name);
    if (local) {
      out.push({
        name: call.name,
        qualified: local.qualified,
        file: defRel,
        line: local.startLine,
        confidence: 'resolved',
        reason: 'defined in this file'
      });
      continue;
    }

    const matches = files
      .map((f) => ({ f, s: f.symbols.find((x) => x.name === call.name) }))
      .filter((m) => m.s);

    if (matches.length === 1) {
      out.push({
        name: call.name,
        qualified: matches[0].s!.qualified,
        file: matches[0].f.rel,
        line: matches[0].s!.startLine,
        confidence: 'heuristic',
        reason: 'single definition found by name'
      });
      continue;
    }
    if (matches.length > 1) {
      out.push({
        name: call.name,
        qualified: call.attribute ? `${call.attribute}.${call.name}` : call.name,
        file: matches[0].f.rel,
        line: matches[0].s!.startLine,
        confidence: 'heuristic',
        reason: `${matches.length} definitions share this name`
      });
      continue;
    }

    // Nothing in the workspace defines it. If it was imported, it is library
    // code — say so, rather than pointing at a file that does not define it.
    const importedFrom = pack.importSourceOf(here?.text ?? text, call);
    out.push({
      name: call.name,
      qualified: call.attribute ? `${call.attribute}.${call.name}` : call.name,
      file: '',
      line: -1,
      confidence: 'external',
      reason: importedFrom ? `from ${importedFrom}` : 'not defined in this workspace'
    });
  }
  return out;
}

/* ------------------------------------------------------------------ feature */

/**
 * Directories that group code without describing it. In a monorepo the top-level
 * segment is almost always one of these, which is why "apps" is a useless answer
 * to "what am I part of".
 */
const CONTAINER_DIRS = new Set([
  'apps', 'app', 'src', 'lib', 'libs', 'packages', 'services', 'modules',
  'backend', 'frontend', 'server', 'python', 'pkg', 'internal', 'code'
]);

function dirOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i === -1 ? '' : rel.slice(0, i);
}

/** Last segment that actually names something, walking back past container dirs. */
function shortName(dir: string): string {
  const parts = dir.split('/').filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (!CONTAINER_DIRS.has(parts[i].toLowerCase())) {
      return parts[i];
    }
  }
  return parts[parts.length - 1] ?? '(root)';
}

/** In a monorepo, the deployable this file belongs to: apps/<api>/... -> "api". */
function serviceOf(rel: string): string | undefined {
  const parts = rel.split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    if (CONTAINER_DIRS.has(parts[i].toLowerCase()) && parts[i + 1] && !packForPath(parts[i + 1])) {
      return parts[i + 1];
    }
  }
  return undefined;
}

/** Directory-level import edges: the zoomed-out sibling of the call graph. */
function directoryEdges(files: FileIndex[]): Map<string, Set<string>> {
  const edges = new Map<string, Set<string>>();
  const byLang = new Map<string, FileIndex[]>();
  for (const f of files) {
    byLang.set(f.lang, [...(byLang.get(f.lang) ?? []), f]);
  }
  for (const f of files) {
    const from = dirOf(f.rel);
    if (!edges.has(from)) {
      edges.set(from, new Set());
    }
    const pack = packForPath(f.rel);
    if (!pack) {
      continue;
    }
    for (const target of pack.importedFiles(f, byLang.get(f.lang) ?? [])) {
      const to = dirOf(target.rel);
      if (to !== from) {
        edges.get(from)!.add(to); // third-party imports never match a workspace file
      }
    }
  }
  return edges;
}

/**
 * Walk the caller graph upward to its roots. Those roots are what actually
 * reaches this code — the route handler, the task, the CLI command.
 */
async function findEntryPoints(
  seeds: SymbolRef[],
  files: FileIndex[],
  entries: EntryPointIndex,
  maxVisits = 24
): Promise<SymbolRef[]> {
  const roots: SymbolRef[] = [];
  const seen = new Set<string>();
  const queue = [...seeds];
  let visits = 0;

  while (queue.length && visits < maxVisits) {
    const node = queue.shift()!;
    const key = `${node.file}#${node.qualified}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    visits++;

    const f = files.find((x) => x.rel === node.file);
    const sym = f?.symbols.find((s) => s.startLine === node.line || s.name === node.name);
    if (!f || !sym) {
      continue;
    }

    // A Go handler is referenced from the function that registers its route, so
    // "nobody calls it" never happens there — a known entry point is a root too.
    if (entries.has(entryKey(f.rel, sym.startLine))) {
      roots.push(node);
      continue;
    }
    const up = await findCallers(sym, f.rel);
    if (up.length === 0) {
      roots.push(node);
    } else {
      queue.push(...up);
    }
  }
  return roots.slice(0, 6);
}

function roleOf(callers: SymbolRef[], callees: number): FeatureContext['role'] {
  if (callers.length === 0) {
    return 'entry point';
  }
  if (callers.length >= 4) {
    return 'shared utility';
  }
  return callees === 0 ? 'leaf' : 'core';
}

async function buildFeature(
  defRel: string,
  callers: SymbolRef[],
  callees: SymbolRef[],
  files: FileIndex[],
  repoRoot: string,
  absFile: string,
  walkFrom: SymbolRef[]
): Promise<FeatureContext> {
  const dir = dirOf(defRel);
  const inDir = files.filter((f) => dirOf(f.rel) === dir);
  const edges = directoryEdges(files);

  const dependedOnBy = [...edges.entries()]
    .filter(([from, to]) => from !== dir && to.has(dir))
    .map(([from]) => shortName(from));

  const [entryPoints, coChange] = await Promise.all([
    findEntryPoints(walkFrom, files, await entryIndex()),
    coChangedFiles(repoRoot, absFile)
  ]);

  const self = shortName(dir);
  // Several directories can collapse to the same short label, which produced a
  // package that appeared to depend on itself. Drop self-references and repeats.
  const clean = (names: string[]) => [...new Set(names)].filter((n) => n !== self);

  return {
    name: self,
    path: dir || '(repository root)',
    service: serviceOf(defRel),
    modules: inDir.length,
    symbols: inDir.reduce((n, f) => n + f.symbols.length, 0),
    role: roleOf(callers, callees.length),
    entryPoints,
    dependsOn: clean([...(edges.get(dir) ?? [])].map(shortName)),
    dependedOnBy: clean(dependedOnBy),
    coChange
  };
}

const TEST_RE = /(^|\/)(tests?|testing)\//i;

function isTestFile(rel: string): boolean {
  return TEST_RE.test(rel) || !!packForPath(rel)?.isTestFile(rel);
}

const NO_WORKFLOW: Workflow = { requires: [], inputs: [], steps: [], confidence: 'heuristic' };

export async function buildContext(
  doc: vscode.TextDocument,
  sym: CodeSymbol
): Promise<ContextResponse> {
  const defRel = relPath(doc.uri);
  const pack = packForLanguage(doc.languageId) ?? packForPath(defRel);
  const files = await indexWorkspace();

  // The language server knows the real call graph; the pack's name rules are
  // the fallback. Languages without a pack depend on the server alone.
  const callerCtx = {
    pack,
    moduleLabel: (rel: string) => pack?.moduleLabel(rel) ?? (rel.split('/').pop() ?? rel).replace(/\.[^.]+$/, ''),
    symbolsOf: async (uri: vscode.Uri) => {
      const rel = relPath(uri);
      const indexed = files.find((f) => f.rel === rel);
      if (indexed) {
        return indexed;
      }
      try {
        const other = await vscode.workspace.openTextDocument(uri);
        const otherPack = packForLanguage(other.languageId);
        const { lspDocumentSymbols } = await import('./lsp');
        const symbols = otherPack ? otherPack.scanSymbols(other.getText()) : (await lspDocumentSymbols(other)) ?? [];
        return { rel, text: other.getText(), symbols };
      } catch {
        return undefined;
      }
    }
  };
  const [serverCallers, serverCallees] = await Promise.all([
    lspCallers(doc, sym, callerCtx),
    lspCallees(doc, sym, relPath)
  ]);
  const callers = serverCallers ?? (pack ? await findCallersByName(sym, defRel, pack) : []);
  const callees = serverCallees ?? (pack ? await resolveCalleesByName(doc.getText(), sym, defRel, pack) : []);
  const sources: ContextResponse['sources'] = {
    callers: serverCallers ? 'language server' : pack ? 'name matching' : 'none',
    callees: serverCallees ? 'language server' : pack ? 'name matching' : 'none'
  };

  // one extra hop, capped, so "transitive" means something without a graph store
  const transitive = new Set<string>();
  for (const c of callers.slice(0, 8)) {
    const f = files.find((x) => x.rel === c.file);
    const s = f?.symbols.find((x) => x.name === c.name);
    if (!f || !s) {
      continue;
    }
    const upstream = await findCallers(s, f.rel);
    upstream.forEach((u) => transitive.add(`${u.file}#${u.qualified}`));
  }
  callers.forEach((c) => transitive.delete(`${c.file}#${c.qualified}`));

  const testFiles = callers.filter((c) => isTestFile(c.file)).map((c) => c.file);

  const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
  const cwd = folder?.uri.fsPath ?? path.dirname(doc.uri.fsPath);
  const root = (await repoRootFor(cwd)) ?? cwd;
  const [sha, dirty, history] = await Promise.all([
    headSha(root),
    isDirty(root, doc.uri.fsPath),
    symbolHistory(root, doc.uri.fsPath, sym.name)
  ]);
  const { authors, uncommittedLines } = await symbolAuthors(
    root, doc.uri.fsPath, sym.startLine, sym.endLine, doc.getText(), history.all, history.source === 'symbol'
  );

  // When this function is itself a route or job, the places that only *name* it
  // are where it gets registered — `r.GET("/x", h.GetUser)` inside main — not
  // further ways in. Elsewhere a reference is often exactly how code is reached
  // (`Depends(get_current_user)` runs on every request), so it only applies here.
  const entries = await entryIndex();
  const isEntryPoint = entries.get(entryKey(defRel, sym.startLine));
  const walkFrom = isEntryPoint ? callers.filter((c) => c.kind !== 'reference') : callers;

  const feature = await buildFeature(defRel, callers, callees, files, root, doc.uri.fsPath, walkFrom);

  // Translate the caller-tree roots into things a person can recognise: a URL,
  // a job, a command. Roots with no framework decorator are left out rather
  // than described as "some function", which would say nothing.
  const reachedFrom: EntryPoint[] = [];
  for (const rootSym of feature.entryPoints) {
    const hit = entries.get(entryKey(rootSym.file, rootSym.line));
    if (hit && !reachedFrom.some((e) => e.label === hit.label)) {
      reachedFrom.push(hit);
    }
  }
  // Direct callers can be entry points too, even when the walk found deeper roots.
  for (const c of walkFrom) {
    const hit = entries.get(entryKey(c.file, c.line));
    if (hit && !reachedFrom.some((e) => e.label === hit.label)) {
      reachedFrom.push(hit);
    }
  }

  // The route path lets the signature parser tell path parameters from body ones.
  const routePath = (isEntryPoint ?? reachedFrom[0])?.label.split(' ').pop();
  const workflow = pack ? pack.buildWorkflow(doc.getText(), sym, routePath) : NO_WORKFLOW;

  return {
    workflow,
    summary: buildSummary(
      sym,
      feature,
      callers,
      callees,
      history.events.length,
      new Set(testFiles).size,
      reachedFrom,
      isEntryPoint
    ),
    reachedFrom,
    isEntryPoint,
    symbol: {
      name: sym.name,
      qualified: sym.qualified,
      file: defRel,
      startLine: sym.startLine,
      endLine: sym.endLine
    },
    purpose: {
      // STUB. In the real product this is the one AI call, over an evidence
      // bundle, cached by content hash. Nothing else on this response is AI.
      text: stubPurpose(sym, callers.length, callees.length, history.events.length),
      type: 'stub',
      evidence: history.events.slice(-3).map((h) => `commit ${h.sha}`)
    },
    feature,
    callers,
    callees,
    history: history.events,
    historySource: history.source,
    historyOlder: history.older,
    authors,
    uncommittedLines,
    sources,
    tests: { count: new Set(testFiles).size, files: [...new Set(testFiles)] },
    impact: { direct: callers.length, transitive: transitive.size },
    indexedAt: sha || 'no git',
    dirty
  };
}

function buildSummary(
  sym: CodeSymbol,
  feature: FeatureContext,
  callers: SymbolRef[],
  callees: SymbolRef[],
  history: number,
  tests: number,
  reachedFrom: EntryPoint[],
  isEntryPoint?: EntryPoint
): string {
  const where =
    feature.service && feature.service !== feature.name
      ? `part of ${feature.name} in the ${feature.service} service`
      : `part of ${feature.name}`;

  // Lead with how the outside world gets here. That is the sentence a reader
  // who does not think in call graphs can actually use.
  let flow: string;
  if (isEntryPoint) {
    flow = `It runs when ${describeEntry(isEntryPoint)}.`;
  } else if (reachedFrom.length === 1) {
    flow = `It runs when ${describeEntry(reachedFrom[0])}.`;
  } else if (reachedFrom.length > 1) {
    const shown = reachedFrom.slice(0, 3).map((e) => e.label);
    const rest = reachedFrom.length - shown.length;
    flow = `It is reached from ${shown.join(', ')}${rest ? ` and ${rest} more` : ''}.`;
  } else if (callers.length === 0) {
    flow = 'Nothing in this workspace reaches it — an entry point, dead code, or called dynamically.';
  } else {
    const calls = callers.filter((c) => c.kind !== 'reference').length;
    const refs = callers.length - calls;
    flow =
      refs && !calls
        ? `It is never called directly — passed as a reference in ${refs} place${refs === 1 ? '' : 's'}.`
        : `It is used in ${callers.length} place${callers.length === 1 ? '' : 's'}, none of which is a route, job or command.`;
  }

  const local = callees.filter((c) => c.confidence !== 'external').length;
  const depends = local ? ` It relies on ${local} other piece${local === 1 ? '' : 's'} of this codebase.` : '';
  const safety = tests
    ? `${tests} test file${tests === 1 ? '' : 's'} cover it`
    : 'nothing tests it, so changes here are not automatically checked';
  const churn = history === 1 ? 'changed once' : `changed ${history} times`;

  return `${sym.name}() is ${where}. ${flow}${depends} It has ${churn} and ${safety}.`;
}

function stubPurpose(sym: CodeSymbol, callers: number, callees: number, changes: number): string {
  void callers;
  void callees;
  return changes > 4
    ? `${sym.qualified} changes often, which usually means the assumptions around it are still moving.`
    : `A real summary would be generated here from an evidence bundle — the only AI call in the product.`;
}

/**
 * Cheap enough to run for every function in a file, which CodeLens needs.
 * Index-only: no git, no transitive hop, no AI.
 */
export async function quickStats(
  doc: vscode.TextDocument,
  sym: CodeSymbol
): Promise<{ callers: number; heuristic: number; callees: number }> {
  const defRel = relPath(doc.uri);
  const pack = packForLanguage(doc.languageId) ?? packForPath(defRel);
  if (!pack) {
    return { callers: 0, heuristic: 0, callees: 0 };
  }
  const callers = await findCallersByName(sym, defRel, pack);
  return {
    callers: callers.length,
    heuristic: callers.filter((c) => c.confidence !== 'resolved').length,
    callees: pack.callsInside(doc.getText(), sym).length
  };
}
