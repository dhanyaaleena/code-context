import * as vscode from 'vscode';
import { ContextCodeLensProvider } from './codelens';
import { ContextHoverProvider } from './hover';
import { ContextPanel } from './panel';
import { symbolAt } from './pythonScan';
import { CodeSymbol } from './lang/types';
import { PACK_SELECTOR, isCodeDocument, symbolsFor } from './symbols';
import { clearAll, getContext } from './cache';
import { indexStats, invalidateIndex, updateFile, watchWorkspace } from './repoIndex';
import { repoRootFor, showCommit } from './git';
import { aiEnabled, editorModelLabel, editorModels, narrate, pickEditorModel, setApiKey } from './ai';
type Sym = CodeSymbol;


export function activate(ctx: vscode.ExtensionContext): void {
  const lenses = new ContextCodeLensProvider();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  status.command = 'codeContext.reindex';

  function showIndexState(): void {
    const s = indexStats();
    if (!s.built) {
      status.hide();
      return;
    }
    status.text = `$(database) ${s.files} files`;
    status.tooltip = `Code Context: ${s.files} source files indexed, ${s.names} names, ${s.updates} incremental update${s.updates === 1 ? '' : 's'} since. Click to re-index.`;
    status.show();
  }
  let narrationTimer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped per request; only the latest request's answer is shown. */
  let narrationSeq = 0;

  /**
   * Debounced so that scrolling through a file does not bill a request per
   * function. Repeats are free anyway — the narration is cached by the hash of
   * its evidence — but the first visit to each symbol is not.
   */
  function requestNarration(
    doc: vscode.TextDocument,
    sym: Sym,
    response: Awaited<ReturnType<typeof getContext>>,
    delay = 700,
    fresh = false
  ): void {
    if (!ContextPanel.current) {
      return;
    }
    if (!aiEnabled()) {
      // AI isn't on: invite the reader to set it up, in the summary block.
      ContextPanel.current.narration({ state: 'setup' });
      return;
    }
    if (narrationTimer) {
      clearTimeout(narrationTimer);
    }
    const seq = ++narrationSeq;
    // The loading state is only shown if the answer is actually slow. A cache
    // hit comes back in a few milliseconds, and flashing "analysing" for that
    // made every background refresh look like work was being redone.
    const showLoading = setTimeout(() => ContextPanel.current?.narration({ state: 'loading' }), fresh ? 0 : 150);
    narrationTimer = setTimeout(async () => {
      const source = doc.getText(new vscode.Range(sym.startLine, 0, sym.endLine + 1, 0));
      const result = await narrate(ctx, response, source, { fresh });
      clearTimeout(showLoading);
      // A slow answer can arrive after the reader has moved on, or after a
      // Re-analyse asked again; only the latest request's answer is shown.
      if (seq !== narrationSeq) {
        return;
      }
      ContextPanel.current?.narration(result);
    }, delay);
  }

  /**
   * The function the panel is showing, and its source as it was analysed.
   *
   * Tracked by qualified name rather than line, because an edit above it moves
   * every line number but leaves the name alone. The source snapshot is what
   * staleness is measured against.
   */
  let focus: { uri: string; qualified: string; line: number; source: string } | undefined;
  let staleTimer: ReturnType<typeof setTimeout> | undefined;
  let shownStale = false;

  function sourceOf(doc: vscode.TextDocument, sym: Sym): string {
    return doc.getText(new vscode.Range(sym.startLine, 0, sym.endLine + 1, 0));
  }

  function setFocus(doc: vscode.TextDocument, sym: Sym): void {
    focus = { uri: doc.uri.toString(), qualified: sym.qualified, line: sym.startLine, source: sourceOf(doc, sym) };
    shownStale = false;
  }

  /** Find the focused function again in the current text of its file. */
  async function locateFocus(): Promise<{ doc: vscode.TextDocument; sym?: Sym } | undefined> {
    if (!focus) {
      return undefined;
    }
    const target = focus;
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(target.uri));
    } catch {
      return undefined;
    }
    const syms = await symbolsFor(doc);
    const sym =
      syms
        .filter((s) => s.qualified === target.qualified)
        .sort((a, b) => Math.abs(a.startLine - target.line) - Math.abs(b.startLine - target.line))[0] ??
      symbolAt(syms, target.line); // renamed in place: follow it rather than lose it
    return { doc, sym };
  }

  /**
   * Re-analyse the focused function. Only ever called by the reader — the
   * button, the command, or opening the panel again.
   */
  async function refreshFocus(fresh = false): Promise<void> {
    if (!ContextPanel.current || !focus) {
      return;
    }
    const target = focus;
    const found = await locateFocus();
    if (!found?.sym) {
      return;
    }
    if (fresh) {
      clearAll();
    }
    const response = await getContext(found.doc, found.sym);
    if (focus !== target) {
      return; // the reader moved on while this was computing
    }
    setFocus(found.doc, found.sym);
    ContextPanel.current?.update(response);
    requestNarration(found.doc, found.sym, response, 0, fresh);
  }

  /**
   * Notice that the code changed; do not act on it.
   *
   * An agent writing a function lands as a stream of edits, and re-analysing
   * each one would bill for descriptions of half-written code nobody asked
   * for. So a change only flags the panel as stale, and the reader decides
   * when it is worth asking again.
   *
   * The comparison is against the function's own source, so an edit elsewhere
   * in the file doesn't flag it, and undoing a change clears the flag.
   */
  async function checkStale(): Promise<void> {
    if (!ContextPanel.current || !focus) {
      return;
    }
    const target = focus;
    const found = await locateFocus();
    if (focus !== target || !found) {
      return;
    }
    const stale = !found.sym || sourceOf(found.doc, found.sym) !== target.source;
    if (stale !== shownStale) {
      shownStale = stale;
      ContextPanel.current?.stale(stale);
    }
  }

  /** Cheap — a text comparison — so a short settle is enough. */
  function scheduleStaleCheck(): void {
    if (!ContextPanel.current || !focus) {
      return;
    }
    if (staleTimer) {
      clearTimeout(staleTimer);
    }
    staleTimer = setTimeout(() => void checkStale(), 400);
  }

  // Build once, in the background, so the first panel open is not the thing
  // that pays for indexing the repository.
  // Fires after any indexed source file changes on disk, including writes from outside
  // the editor. Callers live in other files, so a change anywhere can change
  // what the panel should say about the focused function.
  watchWorkspace(ctx, () => {
    clearAll();
    lenses.refresh();
    showIndexState();
    scheduleStaleCheck();
  });
  void (async () => {
    const { ensureIndex } = await import('./repoIndex');
    await ensureIndex();
    showIndexState();
  })();

  ctx.subscriptions.push(
    vscode.languages.registerHoverProvider(PACK_SELECTOR, new ContextHoverProvider()),
    vscode.languages.registerCodeLensProvider(PACK_SELECTOR, lenses),

    vscode.commands.registerCommand('codeContext.showPanel', async (arg?: { uri: string; line: number }) => {
      const target = await resolveTarget(arg);
      if (!target) {
        void vscode.window.showInformationMessage('Code Context: put the cursor inside a function first.');
        return;
      }
      const { doc, sym } = target;
      await vscode.window.withProgress(
        { location: { viewId: 'workbench.view.explorer' }, title: 'Code Context' },
        async () => {
          const response = await getContext(doc, sym);
          setFocus(doc, sym);
          ContextPanel.show(
            ctx.extensionUri,
            response,
            revealSymbol,
            (sha) => openCommit(doc, sha),
            () => void refreshFocus(true)
          );
          requestNarration(doc, sym, response, 0);
        }
      );
    }),

    vscode.commands.registerCommand('codeContext.revealSymbol', (file: string, line: number) =>
      revealSymbol(file, line)
    ),

    vscode.commands.registerCommand('codeContext.showCommit', async (sha: string) => {
      const doc = vscode.window.activeTextEditor?.document;
      if (doc) {
        await openCommit(doc, sha);
      }
    }),

    // keep the panel following the cursor, the way the design describes
    vscode.window.onDidChangeTextEditorSelection(async (e) => {
      if (!ContextPanel.current || !isCodeDocument(e.textEditor.document)) {
        return;
      }
      // Selection moves caused by an edit arrive with no kind. An agent
      // rewriting code drags the cursor with it, and following that would be
      // exactly the background re-analysis this is meant to avoid. Only a
      // move the reader made — click, arrow keys, go-to-definition — follows.
      if (e.kind === undefined) {
        return;
      }
      const doc = e.textEditor.document;
      const sym = symbolAt(await symbolsFor(doc), e.selections[0].active.line);
      if (!sym) {
        return;
      }
      // Moving within the same function is not a new question, and typing in
      // it moves the cursor on every keystroke. Edits are picked up below,
      // once they settle, instead of being analysed a character at a time.
      if (focus && focus.uri === doc.uri.toString() && focus.qualified === sym.qualified) {
        return;
      }
      setFocus(doc, sym);
      const response = await getContext(doc, sym);
      ContextPanel.current?.update(response);
      requestNarration(doc, sym, response);
    }),

    // Buffer edits to the focused file: typing, Cursor's agent, a paste, an
    // undo. Also fires when a file with no unsaved changes is rewritten on
    // disk and the editor reloads it, which is how Claude Code's edits arrive.
    // Either way, the panel is only told it is stale.
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (focus && e.contentChanges.length && e.document.uri.toString() === focus.uri) {
        scheduleStaleCheck();
      }
    }),

    vscode.commands.registerCommand('codeContext.reanalyse', () => refreshFocus(true)),

    vscode.commands.registerCommand('codeContext.setApiKey', async () => {
      await setApiKey(ctx);
      // A key just saved turns AI on; describe the function on screen now.
      if (aiEnabled() && ContextPanel.current) {
        void refreshFocus(false);
      }
    }),
    // Turning AI on or off in settings.json shows up without moving the cursor.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if ((e.affectsConfiguration('codeContext.ai.enabled') || e.affectsConfiguration('codeContext.ai.model')) && ContextPanel.current) {
        void refreshFocus(false);
      }
    }),

    // Answers "does this editor give extensions any models?" from the editor
    // itself, rather than from documentation that may not cover forks.
    vscode.commands.registerCommand('codeContext.listEditorModels', async () => {
      const models = await editorModels();
      if (models === undefined) {
        void vscode.window.showWarningMessage(
          'Code Context: this editor does not implement the language model API (vscode.lm). Use an API key instead.'
        );
        return;
      }
      if (!models.length) {
        void vscode.window.showWarningMessage(
          'Code Context: this editor implements vscode.lm but offers no models to extensions. In VS Code, installing GitHub Copilot adds them; otherwise use an API key.'
        );
        return;
      }
      const chosen = await pickEditorModel();
      await vscode.window.showQuickPick(
        models.map((m) => ({
          label: (chosen && m.id === chosen.id ? '$(check) ' : '') + editorModelLabel(m),
          description: m.name,
          detail: `id ${m.id} · up to ${m.maxInputTokens.toLocaleString()} input tokens${
            chosen && m.id === chosen.id ? ' · Code Context would use this one' : ''
          }`
        })),
        { title: `${models.length} model(s) available to extensions`, placeHolder: 'Set codeContext.ai.editorModel to choose a different one' }
      );
    }),

    vscode.commands.registerCommand('codeContext.clearNarrationCache', async () => {
      const keys = ctx.globalState.keys().filter((k) => k.startsWith('narration:'));
      await Promise.all(keys.map((k) => ctx.globalState.update(k, undefined)));
      void vscode.window.showInformationMessage(`Code Context: cleared ${keys.length} cached narration(s).`);
    }),

    // A save updates one file in the index, not the whole repository.
    // updateFile notifies the watchWorkspace callback above, which refreshes
    // caches and lenses and re-checks whether the panel is stale.
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      if (isCodeDocument(doc)) {
        await updateFile(doc.uri);
      }
    }),

    vscode.commands.registerCommand('codeContext.reindex', async () => {
      invalidateIndex();
      clearAll();
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Code Context: re-indexing' },
        async () => {
          const { ensureIndex } = await import('./repoIndex');
          await ensureIndex();
        }
      );
      lenses.refresh();
      showIndexState();
    }),

    status
  );
}

async function resolveTarget(
  arg?: { uri: string; line: number }
): Promise<{ doc: vscode.TextDocument; sym: CodeSymbol } | undefined> {
  let doc: vscode.TextDocument | undefined;
  let line: number | undefined;

  if (arg?.uri) {
    doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(arg.uri));
    line = arg.line;
  } else {
    const editor = vscode.window.activeTextEditor;
    if (editor && isCodeDocument(editor.document)) {
      doc = editor.document;
      line = editor.selection.active.line;
    }
  }
  if (!doc || line === undefined) {
    return undefined;
  }

  const sym = symbolAt(await symbolsFor(doc), line);
  return sym ? { doc, sym } : undefined;
}

async function revealSymbol(file: string, line: number): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return;
  }
  const uri = vscode.Uri.joinPath(folder.uri, file);
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc, {
    viewColumn: vscode.ViewColumn.One,
    preserveFocus: false
  });
  const range = new vscode.Range(line, 0, line, 0);
  editor.selection = new vscode.Selection(range.start, range.start);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

async function openCommit(doc: vscode.TextDocument, sha: string): Promise<void> {
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
  const root = (await repoRootFor(folder?.uri.fsPath ?? '')) ?? folder?.uri.fsPath;
  if (!root) {
    return;
  }
  const patch = await showCommit(root, sha);
  const shown = await vscode.workspace.openTextDocument({ content: patch, language: 'diff' });
  await vscode.window.showTextDocument(shown, { viewColumn: vscode.ViewColumn.One, preview: true });
}

export function deactivate(): void {
  clearAll();
}
