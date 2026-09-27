import * as vscode from 'vscode';
import { ContextResponse, Narration } from './types';

/**
 * Tier 3 — the map.
 *
 * A webview is the only surface in VS Code that can render the real design:
 * full HTML, CSS and SVG, with click targets on the nodes. It opens Beside the
 * editor so the code stays visible, which is the whole point.
 */
export class ContextPanel {
  static current: ContextPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  static show(
    extensionUri: vscode.Uri,
    ctx: ContextResponse,
    onNavigate: (file: string, line: number) => void,
    onCommit: (sha: string) => void,
    onReanalyse: () => void
  ): void {
    if (ContextPanel.current) {
      ContextPanel.current.panel.reveal(vscode.ViewColumn.Beside, true);
      ContextPanel.current.update(ctx);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'codeContext.panel',
      'Code Context',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
      }
    );
    ContextPanel.current = new ContextPanel(panel, extensionUri, onNavigate, onCommit, onReanalyse);
    ContextPanel.current.update(ctx);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    onNavigate: (file: string, line: number) => void,
    onCommit: (sha: string) => void,
    onReanalyse: () => void
  ) {
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg) => {
        if (msg?.type === 'navigate' && typeof msg.file === 'string') {
          onNavigate(msg.file, Number(msg.line) || 0);
        } else if (msg?.type === 'commit' && typeof msg.sha === 'string') {
          onCommit(msg.sha);
        } else if (msg?.type === 'reanalyse') {
          onReanalyse();
        } else if (msg?.type === 'setupAi') {
          void vscode.commands.executeCommand('codeContext.setApiKey');
        } else if (msg?.type === 'toggleAi') {
          void vscode.commands.executeCommand('codeContext.toggleAi');
        }
      },
      null,
      this.disposables
    );
  }

  update(ctx: ContextResponse): void {
    this.panel.title = `Context — ${ctx.symbol.name}`;
    void this.panel.webview.postMessage({ type: 'context', payload: ctx });
  }

  /** The code under the panel changed since it was analysed. Shown, not acted on. */
  stale(on: boolean): void {
    void this.panel.webview.postMessage({ type: 'stale', on });
  }

  /** Folded in when the model answers; the panel is already useful without it. */
  /** Whether AI is on, and whether any key exists — drives the panel's AI switch. */
  aiState(state: { enabled: boolean; hasKey: boolean }): void {
    void this.panel.webview.postMessage({ type: 'ai', ...state });
  }

  narration(payload: Narration | { state: 'loading' } | { state: 'setup'; provider?: string }): void {
    void this.panel.webview.postMessage({ type: 'narration', payload });
  }

  private html(): string {
    const w = this.panel.webview;
    const css = w.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'panel.css'));
    const js = w.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'panel.js'));
    const nonce = Array.from({ length: 32 }, () =>
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.charAt(
        Math.floor(Math.random() * 62)
      )
    ).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${w.cspSource} data:; style-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${css}" rel="stylesheet">
<title>Code Context</title>
</head>
<body>
  <div id="root"><p class="empty">Put the cursor inside a function.</p></div>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    ContextPanel.current = undefined;
    this.panel.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
