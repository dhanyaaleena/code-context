import * as vscode from 'vscode';
import { createHash } from 'crypto';
import { PySymbol, relPath, scanSymbols } from './pythonScan';
import { EntryPointIndex, scanEntryPoints } from './entryPoints';
import { changedBetween, dirtyFiles, headSha, repoRootFor } from './git';

/**
 * The repository index: built once, then only the files that change are touched.
 *
 * Two properties matter here. The first is incrementality — a save re-reads one
 * file, not four hundred. The second is the inverted name index: "who mentions
 * `calculate_total`" used to mean a regex sweep of every file, and every caller
 * lookup paid for it. Since a single panel open performs dozens of those lookups
 * (the transitive hop and the entry-point walk each do their own), the sweep was
 * the dominant cost. Now it is a map read.
 */

export interface FileIndex {
  uri: vscode.Uri;
  rel: string;
  text: string;
  symbols: PySymbol[];
}

export interface Repo {
  files: FileIndex[];
  byRel: Map<string, FileIndex>;
  entries: EntryPointIndex;
  /** identifier → the files that mention it anywhere */
  byName: Map<string, Set<string>>;
  builtAt: number;
  updates: number;
  /** Set when the index was restored from disk rather than read fresh. */
  fromCache?: { reused: number; reread: number };
}

const EXCLUDE = '**/{.venv,venv,env,node_modules,site-packages,__pycache__,.git,build,dist,.tox,.mypy_cache}/**';
const IDENT_RE = /[A-Za-z_]\w*/g;

let repo: Repo | undefined;
let building: Promise<Repo> | undefined;
let watcher: vscode.FileSystemWatcher | undefined;
let onChanged: (() => void) | undefined;
let storage: vscode.Uri | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

/** Bump when the cache's own shape changes; symbols are always rescanned. */
const CACHE_VERSION = 2;
/** Above this, writing the cache costs more than rebuilding it. */
const MAX_CACHE_BYTES = 24 * 1024 * 1024;

interface DiskCache {
  v: number;
  root: string;
  maxFiles: number;
  sha: string;
  files: { rel: string; text: string }[];
}

function emptyRepo(): Repo {
  return { files: [], byRel: new Map(), entries: new Map(), byName: new Map(), builtAt: 0, updates: 0 };
}

function identifiersOf(text: string): Set<string> {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(IDENT_RE.source, 'g');
  while ((m = re.exec(text))) {
    out.add(m[0]);
  }
  return out;
}

function addToNameIndex(index: Map<string, Set<string>>, rel: string, text: string): void {
  for (const ident of identifiersOf(text)) {
    let set = index.get(ident);
    if (!set) {
      set = new Set();
      index.set(ident, set);
    }
    set.add(rel);
  }
}

function dropFromNameIndex(index: Map<string, Set<string>>, rel: string): void {
  for (const [ident, set] of index) {
    if (set.delete(rel) && set.size === 0) {
      index.delete(ident);
    }
  }
}

async function readFile(uri: vscode.Uri): Promise<FileIndex | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(bytes).toString('utf8');
    return { uri, rel: relPath(uri), text, symbols: scanSymbols(text) };
  } catch {
    return undefined; // unreadable or deleted between listing and reading
  }
}

async function build(): Promise<Repo> {
  const max = vscode.workspace.getConfiguration('codeContext').get<number>('maxFiles', 400);
  const uris = await vscode.workspace.findFiles('**/*.py', EXCLUDE, max);

  const next = emptyRepo();
  for (const uri of uris) {
    const file = await readFile(uri);
    if (!file) {
      continue;
    }
    next.files.push(file);
    next.byRel.set(file.rel, file);
    addToNameIndex(next.byName, file.rel, file.text);
  }
  next.entries = scanEntryPoints(next.files);
  next.builtAt = Date.now();
  repo = next;
  scheduleSave();
  return next;
}

/* ------------------------------------------------------------ persistence */

function cacheUri(root: string): vscode.Uri | undefined {
  if (!storage) {
    return undefined;
  }
  const key = createHash('sha1').update(root).digest('hex').slice(0, 16);
  return vscode.Uri.joinPath(storage, `index-${key}.json`);
}

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

async function writeCache(): Promise<void> {
  const root = workspaceRoot();
  if (!repo || !root || !storage) {
    return;
  }
  const uri = cacheUri(root);
  if (!uri) {
    return;
  }
  const bytes = repo.files.reduce((n, f) => n + f.text.length, 0);
  if (bytes > MAX_CACHE_BYTES) {
    return; // a repository this size is cheaper to rescan than to serialise
  }
  try {
    const gitRoot = (await repoRootFor(root)) ?? root;
    const payload: DiskCache = {
      v: CACHE_VERSION,
      root,
      maxFiles: vscode.workspace.getConfiguration('codeContext').get<number>('maxFiles', 400),
      sha: await headSha(gitRoot),
      files: repo.files.map((f) => ({ rel: f.rel, text: f.text }))
    };
    await vscode.workspace.fs.createDirectory(storage);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(payload), 'utf8'));
  } catch {
    // a cache that cannot be written is not an error worth surfacing
  }
}

function scheduleSave(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
  }
  saveTimer = setTimeout(() => void writeCache(), 4000);
}

/**
 * A cold start does not have to mean a full read.
 *
 * The commit SHA the cache was written at tells us exactly which files can have
 * changed since — `git diff --name-only` for committed movement, `git status`
 * for uncommitted edits. Everything else is reused verbatim, so switching
 * branches re-reads the handful of files that differ rather than the repository.
 */
async function loadCache(): Promise<Repo | undefined> {
  const root = workspaceRoot();
  const uri = root ? cacheUri(root) : undefined;
  if (!root || !uri) {
    return undefined;
  }

  let cached: DiskCache;
  try {
    const raw = await vscode.workspace.fs.readFile(uri);
    cached = JSON.parse(Buffer.from(raw).toString('utf8')) as DiskCache;
  } catch {
    return undefined;
  }

  const maxFiles = vscode.workspace.getConfiguration('codeContext').get<number>('maxFiles', 400);
  if (cached.v !== CACHE_VERSION || cached.root !== root || cached.maxFiles !== maxFiles) {
    return undefined;
  }

  const gitRoot = (await repoRootFor(root)) ?? root;
  const sha = await headSha(gitRoot);
  if (!sha || !cached.sha) {
    return undefined; // no git, so nothing vouches for the cache
  }

  const moved = sha === cached.sha ? [] : await changedBetween(gitRoot, cached.sha, sha);
  if (moved === undefined) {
    return undefined; // the cached commit is gone — rebased or pruned
  }
  const dirty = await dirtyFiles(gitRoot);
  const suspect = new Set([...moved, ...dirty].filter((p) => p.endsWith('.py')));

  const next = emptyRepo();
  for (const entry of cached.files) {
    if (suspect.has(entry.rel)) {
      continue; // re-read below
    }
    const file: FileIndex = {
      uri: vscode.Uri.joinPath(vscode.Uri.file(root), entry.rel),
      rel: entry.rel,
      text: entry.text,
      symbols: scanSymbols(entry.text)
    };
    next.files.push(file);
    next.byRel.set(file.rel, file);
    addToNameIndex(next.byName, file.rel, file.text);
  }

  for (const rel of suspect) {
    const file = await readFile(vscode.Uri.joinPath(vscode.Uri.file(root), rel));
    if (!file) {
      continue; // deleted
    }
    next.files.push(file);
    next.byRel.set(file.rel, file);
    addToNameIndex(next.byName, file.rel, file.text);
  }

  next.entries = scanEntryPoints(next.files);
  next.builtAt = Date.now();
  next.updates = 0;
  next.fromCache = { reused: cached.files.length - suspect.size, reread: suspect.size };
  repo = next;
  scheduleSave();
  return next;
}

/** Builds on first use, then returns the same index for the rest of the session. */
export async function ensureIndex(): Promise<Repo> {
  if (repo) {
    return repo;
  }
  if (!building) {
    building = (async () => (await loadCache()) ?? (await build()))().finally(() => {
      building = undefined;
    });
  }
  return building;
}

/**
 * One file changed. Re-read that file, refresh its slice of the name index, and
 * rescan entry points — the whole corpus is left alone.
 */
export async function updateFile(uri: vscode.Uri): Promise<void> {
  if (!repo) {
    return; // nothing built yet; the first request will build it
  }
  const file = await readFile(uri);
  const rel = relPath(uri);
  const existing = repo.byRel.get(rel);

  if (!file) {
    removeFile(uri);
    return;
  }

  if (existing) {
    const at = repo.files.indexOf(existing);
    if (at >= 0) {
      repo.files[at] = file;
    }
    dropFromNameIndex(repo.byName, rel);
  } else {
    repo.files.push(file);
  }
  repo.byRel.set(rel, file);
  addToNameIndex(repo.byName, rel, file.text);

  // Decorators can move between files, and the mount prefix for a route is
  // resolved across files, so entry points are rescanned rather than patched.
  repo.entries = scanEntryPoints(repo.files);
  repo.updates++;
  scheduleSave();
  onChanged?.();
}

export function removeFile(uri: vscode.Uri): void {
  if (!repo) {
    return;
  }
  const rel = relPath(uri);
  const existing = repo.byRel.get(rel);
  if (!existing) {
    return;
  }
  repo.files = repo.files.filter((f) => f.rel !== rel);
  repo.byRel.delete(rel);
  dropFromNameIndex(repo.byName, rel);
  repo.entries = scanEntryPoints(repo.files);
  repo.updates++;
  scheduleSave();
  onChanged?.();
}

/** Full rebuild. Only for a workspace change or an explicit re-index. */
export function invalidateIndex(): void {
  repo = undefined;
}

/**
 * The files that mention this identifier at all — the candidate set for a
 * caller search, usually a handful rather than the whole repository.
 */
export async function filesMentioning(name: string): Promise<FileIndex[]> {
  const r = await ensureIndex();
  const rels = r.byName.get(name);
  if (!rels) {
    return [];
  }
  const out: FileIndex[] = [];
  for (const rel of rels) {
    const f = r.byRel.get(rel);
    if (f) {
      out.push(f);
    }
  }
  return out;
}

export function indexStats(): {
  files: number;
  names: number;
  updates: number;
  built: boolean;
  fromCache?: { reused: number; reread: number };
} {
  return {
    files: repo?.files.length ?? 0,
    names: repo?.byName.size ?? 0,
    updates: repo?.updates ?? 0,
    built: !!repo,
    fromCache: repo?.fromCache
  };
}

/**
 * Watch the workspace so edits made outside the editor — a branch switch, a
 * rebase, another tool writing files — are picked up too.
 */
export function watchWorkspace(context: vscode.ExtensionContext, changed: () => void): void {
  onChanged = changed;
  storage = context.globalStorageUri;
  if (watcher) {
    return;
  }
  watcher = vscode.workspace.createFileSystemWatcher('**/*.py');
  context.subscriptions.push(
    watcher,
    watcher.onDidChange((uri) => void updateFile(uri)),
    watcher.onDidCreate((uri) => void updateFile(uri)),
    watcher.onDidDelete((uri) => removeFile(uri)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      invalidateIndex();
      changed();
    })
  );
}
