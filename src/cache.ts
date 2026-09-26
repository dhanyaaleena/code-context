import * as vscode from 'vscode';
import { PySymbol } from './pythonScan';
import { ContextResponse } from './types';
import { buildContext, quickStats } from './context';

/**
 * Hover and CodeLens both fire constantly, so everything they ask for is memoized
 * against the document version. This is the local stand-in for the server-side
 * context cache keyed by repo + commit + symbol.
 */

const TTL_MS = 30_000;

interface Entry<T> {
  value: Promise<T>;
  at: number;
}

const contexts = new Map<string, Entry<ContextResponse>>();
const stats = new Map<string, Entry<{ callers: number; heuristic: number; callees: number }>>();

function key(doc: vscode.TextDocument, sym: PySymbol): string {
  return `${doc.uri.toString()}@${doc.version}#${sym.qualified}:${sym.startLine}`;
}

function memo<T>(store: Map<string, Entry<T>>, k: string, make: () => Promise<T>): Promise<T> {
  const hit = store.get(k);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return hit.value;
  }
  const value = make().catch((err) => {
    store.delete(k);
    throw err;
  });
  store.set(k, { value, at: Date.now() });
  if (store.size > 200) {
    const oldest = [...store.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    store.delete(oldest[0]);
  }
  return value;
}

export function getContext(doc: vscode.TextDocument, sym: PySymbol): Promise<ContextResponse> {
  return memo(contexts, key(doc, sym), () => buildContext(doc, sym));
}

export function getStats(doc: vscode.TextDocument, sym: PySymbol) {
  return memo(stats, key(doc, sym), () => quickStats(doc, sym));
}

export function clearAll(): void {
  contexts.clear();
  stats.clear();
}
