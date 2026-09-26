import * as vscode from 'vscode';
import { CodeSymbol } from './lang/types';
import { PACKS, packForLanguage, packForPath } from './lang';
import { lspDocumentSymbols } from './lsp';

/**
 * The functions in a document, from whoever can say.
 *
 * A language pack reads them from the text, instantly. Any other language asks
 * its language server, which is slower but means the panel works in files no
 * pack understands — TypeScript, Rust, Java — as long as the editor does.
 */
export async function symbolsFor(doc: vscode.TextDocument): Promise<CodeSymbol[]> {
  const pack = packForLanguage(doc.languageId) ?? packForPath(doc.uri.fsPath);
  if (pack) {
    return pack.scanSymbols(doc.getText());
  }
  if (doc.uri.scheme !== 'file') {
    return [];
  }
  return (await lspDocumentSymbols(doc)) ?? [];
}

/** Files the panel can describe: anything on disk; whether it has symbols decides the rest. */
export function isCodeDocument(doc: vscode.TextDocument): boolean {
  return doc.uri.scheme === 'file';
}

/** Languages with a pack get the always-on affordances: CodeLens and hover. */
export const PACK_SELECTOR: vscode.DocumentSelector = PACKS.flatMap((p) =>
  p.languageIds.map((language) => ({ language, scheme: 'file' }))
);
