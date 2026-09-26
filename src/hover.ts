import * as vscode from 'vscode';
import { symbolAt } from './pythonScan';
import { symbolsFor } from './symbols';
import { getContext } from './cache';

/**
 * Tier 2 — the digest.
 *
 * Text only, on purpose. VS Code hovers render a sanitized HTML subset, no CSS,
 * no scripts, and SVG images are broken in hovers, so the map cannot live here.
 * What a hover is good for is answering "do I need to look at this?" in one glance.
 */
export class ContextHoverProvider implements vscode.HoverProvider {
  async provideHover(
    doc: vscode.TextDocument,
    pos: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.Hover | undefined> {
    const sym = symbolAt(await symbolsFor(doc), pos.line);
    if (!sym) {
      return undefined;
    }

    const ctx = await getContext(doc, sym);
    if (token.isCancellationRequested) {
      return undefined;
    }

    const md = new vscode.MarkdownString(undefined, true); // true = support codicons
    md.isTrusted = true;   // required for command: links
    md.supportHtml = true; // allowed: img, span with color/background-color, basic markup

    const stale = ctx.dirty
      ? `$(warning) buffer is ahead of \`${ctx.indexedAt}\``
      : `$(check) as of \`${ctx.indexedAt}\``;

    md.appendMarkdown(`**\`${ctx.symbol.qualified}()\`** &nbsp; ${stale}\n\n`);
    const way = ctx.isEntryPoint ?? ctx.reachedFrom[0];
    if (way) {
      md.appendMarkdown(`$(globe) **${way.label}**${ctx.reachedFrom.length > 1 ? ` and ${ctx.reachedFrom.length - 1} more` : ''}\n\n`);
    }
    md.appendMarkdown(`${ctx.summary}\n\n`);
    md.appendMarkdown(`---\n\n`);
    md.appendMarkdown(
      `$(arrow-up) **${ctx.callers.length}** callers &nbsp;·&nbsp; ` +
        `$(arrow-down) **${ctx.callees.length}** calls &nbsp;·&nbsp; ` +
        `$(beaker) **${ctx.tests.count}** test files &nbsp;·&nbsp; ` +
        `$(git-commit) **${ctx.history.length}** changes\n\n`
    );

    const shaky = ctx.callers.filter((c) => c.confidence !== 'resolved').length;
    if (shaky > 0) {
      md.appendMarkdown(
        `<span style="color:#e08b7a;">$(alert) ${shaky} of ${ctx.callers.length} caller edges are heuristic</span>\n\n`
      );
    }

    const last = ctx.history[ctx.history.length - 1];
    if (last) {
      const when = new Date(last.date).toISOString().slice(0, 10);
      const flag = last.aiAssisted ? ' $(sparkle) **AI-assisted**' : '';
      md.appendMarkdown(`Last change ${when} by ${last.author}${flag}\n\n`);
      md.appendMarkdown(`> ${last.subject}\n\n`);
    }

    md.appendMarkdown(`${link('Open context map', 'codeContext.showPanel')}`);
    return new vscode.Hover(md, new vscode.Range(sym.startLine, 0, sym.startLine, 0));
  }
}

function link(label: string, command: string, args?: unknown[]): string {
  const query = args ? `?${encodeURIComponent(JSON.stringify(args))}` : '';
  return `[$(open-preview) ${label}](command:${command}${query})`;
}
