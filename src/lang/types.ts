import { EntryPoint, Workflow } from '../types';

/**
 * Everything the product needs to know about one language.
 *
 * The rest of the extension — the panel, Git history, staleness, the AI layer —
 * never looks at syntax. What varies by language is only this: how to find a
 * function, how a use of one is written, how the body reads as steps, and how
 * frameworks register the routes and jobs that reach it. A new language is a
 * new implementation of this interface, nothing more.
 *
 * Nothing here touches the editor API, so a pack can be exercised on plain text.
 */

export interface CodeSymbol {
  name: string;
  /** `Class.method`, `Receiver.Method`, or just the name. */
  qualified: string;
  kind: 'function' | 'method' | 'class';
  startLine: number;   // 0-based, the definition line
  endLine: number;     // 0-based, inclusive
  /** Nesting depth; the innermost symbol wins when a line sits inside several. */
  indent: number;
}

export interface RawCall {
  name: string;
  /** The thing before the dot: a module, a package, a receiver. */
  attribute?: string;
  line: number;
}

export interface ScannedFile {
  rel: string;
  text: string;
  symbols: CodeSymbol[];
}

/** Keyed by `${file}#${defLine}` so a symbol can be looked up by where it is defined. */
export type EntryPointIndex = Map<string, EntryPoint>;

export function entryKey(file: string, line: number): string {
  return `${file}#${line}`;
}

/**
 * How sure a regex-level reading can be that a line in `file` refers to the
 * target. Only used when no language server answers.
 */
export type Resolution = 'resolved' | 'heuristic' | 'skip';

export interface LanguagePack {
  id: string;
  /** VS Code language ids this pack handles. */
  languageIds: string[];
  /** File extensions, with the dot. */
  extensions: string[];
  /** Directory names never worth indexing (vendored or generated code). */
  excludeDirs: string[];

  scanSymbols(text: string): CodeSymbol[];
  callsInside(text: string, sym: CodeSymbol): RawCall[];

  /** The line with its trailing comment removed, strings left intact. */
  stripComment(line: string): string;
  isImportLine(line: string): boolean;
  /** True when `line` defines (rather than uses) something called `name`. */
  isDefinitionLine(line: string, name: string): boolean;
  /** Regex fallback: does this use in `file` refer to `target` defined in `defRel`? */
  resolve(file: ScannedFile, defRel: string, target: CodeSymbol, line: string): Resolution;
  /** For a call nothing in the workspace defines: where it comes from, if imported. */
  importSourceOf(text: string, call: RawCall): string | undefined;
  /** The label a caller's qualified name is prefixed with — module or package. */
  moduleLabel(rel: string): string;
  isTestFile(rel: string): boolean;
  /** Workspace files this file imports, for directory-level dependency edges. */
  importedFiles(file: ScannedFile, files: ScannedFile[]): ScannedFile[];

  buildWorkflow(text: string, sym: CodeSymbol, routePath?: string): Workflow;
  /** Routes, jobs, commands and events defined across this language's files. */
  scanEntryPoints(files: ScannedFile[]): EntryPointIndex;
}
