import * as vscode from 'vscode';
import { symbolsFor } from './symbols';
import { getStats } from './cache';

/**
 * Tier 1 — the click target.
 *
 * This is the affordance a hover cannot provide: always visible, no interaction
 * required to see it, and one click into the map. It doubles as the ambient
 * signal — you notice a high-churn or heuristic-heavy function while scrolling past.
 */
type LensWithDoc = vscode.CodeLens & { docUri?: string };

export class ContextCodeLensProvider implements vscode.CodeLensProvider {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  refresh(): void {
    this.emitter.fire();
  }

  async provideCodeLenses(doc: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    if (!vscode.workspace.getConfiguration('codeContext').get<boolean>('codeLens', true)) {
      return [];
    }
    return (await symbolsFor(doc))
      .filter((s) => s.kind !== 'class')
      .map((s) => {
        const lens = new vscode.CodeLens(new vscode.Range(s.startLine, 0, s.startLine, 0));
        (lens as LensWithDoc).docUri = doc.uri.toString();
        return lens;
      });
  }

  async resolveCodeLens(
    lens: vscode.CodeLens,
    token: vscode.CancellationToken
  ): Promise<vscode.CodeLens> {
    // The lens's own document — not whichever editor happens to be active, which
    // gave a split view's lenses the other file's numbers.
    const uri = (lens as LensWithDoc).docUri;
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri);
    if (!doc) {
      lens.command = { title: '$(circle-outline) Code Context', command: '' };
      return lens;
    }

    const line = lens.range.start.line;
    const sym = (await symbolsFor(doc)).find((s) => s.startLine === line);
    if (!sym) {
      lens.command = { title: '$(circle-outline) Code Context', command: '' };
      return lens;
    }

    try {
      const s = await getStats(doc, sym);
      if (token.isCancellationRequested) {
        return lens;
      }
      const warn = s.heuristic > 0 ? `  $(alert) ${s.heuristic} heuristic` : '';
      lens.command = {
        title: `$(symbol-namespace) ${s.callers} callers · ${s.callees} calls${warn}   —   Show context`,
        command: 'codeContext.showPanel',
        arguments: [{ uri: doc.uri.toString(), line }]
      };
    } catch {
      lens.command = { title: '$(circle-slash) context unavailable', command: '' };
    }
    return lens;
  }
}
