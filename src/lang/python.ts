import { LanguagePack, RawCall, Resolution, ScannedFile, CodeSymbol } from './types';
import { callsInside, scanSymbols } from '../pythonScan';
import { buildWorkflow } from '../workflow';
import { scanEntryPoints } from '../entryPoints';

/**
 * Python: the original language, moved behind the pack interface unchanged.
 * Symbols by `def`/`class` and indentation, uses resolved through `import`.
 */

const IMPORT_LINE_RE = /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm;

function importRe(name: string): RegExp {
  return new RegExp(
    `^\\s*(from\\s+\\S+\\s+import\\s+.*\\b${name}\\b|import\\s+.*\\b${name}\\b)`,
    'm'
  );
}

/** A dotted import resolved to a workspace file, so edges join real directories. */
function moduleToFile(modulePath: string, files: ScannedFile[]): ScannedFile | undefined {
  const asPath = modulePath.replace(/\./g, '/');
  return (
    files.find((f) => f.rel === `${asPath}.py` || f.rel === `${asPath}/__init__.py`) ??
    files.find((f) => f.rel.endsWith(`/${asPath}.py`) || f.rel.endsWith(`/${asPath}/__init__.py`))
  );
}

export const python: LanguagePack = {
  id: 'python',
  languageIds: ['python'],
  extensions: ['.py'],
  excludeDirs: ['.venv', 'venv', 'env', 'site-packages', '__pycache__', '.tox', '.mypy_cache'],

  scanSymbols,
  callsInside,

  stripComment: (line) => line.replace(/#.*$/, ''),
  isImportLine: (line) => /^\s*(from\s+\S+\s+)?import\s/.test(line),
  // A `def` line can legitimately reference the symbol — default arguments and
  // decorators both live there — so only a line that *defines* the name counts.
  isDefinitionLine: (line, name) => new RegExp(`^\\s*(?:async\\s+)?(?:def|class)\\s+${name}\\b`).test(line),

  resolve(file: ScannedFile, defRel: string, target: CodeSymbol): Resolution {
    return file.rel === defRel || importRe(target.name).test(file.text) ? 'resolved' : 'heuristic';
  },

  importSourceOf(text: string, call: RawCall): string | undefined {
    return new RegExp(`^\\s*from\\s+([\\w.]+)\\s+import\\s+.*\\b${call.name}\\b`, 'm').exec(text)?.[1];
  },

  moduleLabel: (rel) => (rel.split('/').pop() ?? rel).replace(/\.py$/, ''),
  isTestFile: (rel) => /(^|\/)test_[^/]+\.py$/.test(rel) || /_test\.py$/.test(rel),

  importedFiles(file: ScannedFile, files: ScannedFile[]): ScannedFile[] {
    const out: ScannedFile[] = [];
    const re = new RegExp(IMPORT_LINE_RE.source, 'gm');
    let m: RegExpExecArray | null;
    while ((m = re.exec(file.text))) {
      const target = moduleToFile(m[1] ?? m[2] ?? '', files);
      if (target) {
        out.push(target);
      }
    }
    return out;
  },

  buildWorkflow,
  scanEntryPoints
};
