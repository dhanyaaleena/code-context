import { PySymbol } from './pythonScan';
import { EntryPointIndex, ScannedFile, entryKey } from './lang/types';
import { EntryPoint, EntryKind } from './types';

/**
 * Entry-point extraction: the bridge from code vocabulary to product vocabulary.
 *
 * A call graph can say "this is reached from routes.admin_stats". Only the
 * framework decorators can say "this runs when someone opens GET /admin/stats",
 * and that second sentence is the one a non-engineer can read. Everything here
 * is deterministic — it is the evidence an AI narration would be grounded in,
 * not a replacement for it.
 */

export type { ScannedFile, EntryPointIndex } from './lang/types';
export { entryKey } from './lang/types';

const HTTP_RE =
  /@(\w+)\.(get|post|put|patch|delete|head|options|route|api_route)\s*\(\s*(?:path\s*=\s*)?['"]([^'"]+)['"]/;
const METHODS_RE = /methods\s*=\s*\[([^\]]*)\]/;
const CELERY_RE = /@(?:shared_task|(?:\w+)\.task)\b/;
const TASK_NAME_RE = /name\s*=\s*['"]([^'"]+)['"]/;
const CLI_RE = /@(?:click|\w+)\.command\s*\(/;
const CLI_NAME_RE = /command\s*\(\s*['"]([^'"]+)['"]/;
const EVENT_RE = /@(?:\w+)\.on_event\s*\(\s*['"](\w+)['"]/;
const SIGNAL_RE = /@receiver\s*\(\s*([\w.]+)/;
const SCHEDULE_RE = /@(?:\w+)\.scheduled_job\s*\(\s*['"](\w+)['"]/;
const CRON_RE = /(?:cron|hour|minute|day|seconds|minutes|hours)\s*=\s*['"]?([^,)'"]+)['"]?/;

/** `router = APIRouter(prefix="/admin")` and Flask's `Blueprint(url_prefix=...)`. */
const ROUTER_DECL_RE = /^(\w+)\s*=\s*(?:APIRouter|Blueprint)\s*\(([\s\S]*?)\)/gm;
const PREFIX_RE = /(?:prefix|url_prefix)\s*=\s*['"]([^'"]+)['"]/;
/** `app.include_router(orders.router, prefix="/api/v1")` — mounted somewhere else. */
const INCLUDE_RE = /include_router\s*\(\s*([\w.]+)[\s\S]{0,160}?prefix\s*=\s*['"]([^'"]+)['"]/g;

export function scanEntryPoints(files: ScannedFile[]): EntryPointIndex {
  const mountPrefixes = collectMountPrefixes(files);
  const index: EntryPointIndex = new Map();

  for (const f of files) {
    const lines = f.text.split(/\r?\n/);
    const localPrefixes = collectLocalPrefixes(f.text);

    for (const sym of f.symbols) {
      if (sym.kind === 'class') {
        continue;
      }
      const block = decoratorBlock(lines, sym.startLine);
      if (!block) {
        continue;
      }
      const entry = classify(block, f, sym, localPrefixes, mountPrefixes);
      if (entry) {
        index.set(entryKey(f.rel, sym.startLine), entry);
      }
    }
  }
  return index;
}

/**
 * The decorator lines immediately above a def. Decorators wrap across lines, so
 * a small window joined into one string is more robust than parsing line by line.
 */
function decoratorBlock(lines: string[], defLine: number): string | undefined {
  const collected: string[] = [];
  for (let i = defLine - 1; i >= 0 && defLine - i <= 8; i--) {
    const line = lines[i];
    if (!line.trim()) {
      if (collected.length) {
        break;
      }
      continue;
    }
    collected.unshift(line);
    if (/^\s*@/.test(line)) {
      // reached the start of a decorator; keep going in case several are stacked
      continue;
    }
    if (!/[,(\[]\s*$/.test(line) && !/^\s*\)/.test(line) && !/^\s*[\w"']/.test(line)) {
      break;
    }
  }
  const block = collected.join('\n');
  return block.includes('@') ? block : undefined;
}

function classify(
  block: string,
  f: ScannedFile,
  sym: PySymbol,
  localPrefixes: Map<string, string>,
  mountPrefixes: Map<string, string>
): EntryPoint | undefined {
  const base = (kind: EntryKind, label: string, framework: string, detail?: string): EntryPoint => ({
    kind,
    label,
    framework,
    detail,
    symbol: {
      name: sym.name,
      qualified: sym.qualified,
      file: f.rel,
      line: sym.startLine,
      confidence: 'resolved',
      reason: `${framework} ${kind} entry point`
    }
  });

  const http = HTTP_RE.exec(block);
  if (http) {
    const [, routerVar, verb, rawPath] = http;
    const mount = mountPrefixes.get(moduleName(f.rel)) ?? '';
    const full = joinPath(mount, localPrefixes.get(routerVar) ?? '', rawPath);
    const methods =
      verb === 'route' || verb === 'api_route'
        ? (METHODS_RE.exec(block)?.[1] ?? 'GET')
            .replace(/['"\s]/g, '')
            .split(',')
            .filter(Boolean)
            .join('/')
        : verb.toUpperCase();
    // The decorator alone cannot tell the frameworks apart — `@bp.route(...)`
    // looks identical either way — so the import list is the real signal.
    const framework = /^\s*(from|import)\s+flask\b/m.test(f.text) ? 'flask' : 'fastapi';
    // The label already carries the full path; repeating the prefix adds noise.
    return base('http', `${methods} ${full}`, framework);
  }

  if (CELERY_RE.test(block)) {
    const name = TASK_NAME_RE.exec(block)?.[1] ?? sym.name;
    return base('task', `background job: ${humanise(name)}`, 'celery');
  }

  const schedule = SCHEDULE_RE.exec(block);
  if (schedule) {
    const when = CRON_RE.exec(block)?.[1]?.trim();
    return base('schedule', `scheduled: ${humanise(sym.name)}`, 'apscheduler', when ? `runs ${when}` : undefined);
  }

  if (CLI_RE.test(block)) {
    const name = CLI_NAME_RE.exec(block)?.[1] ?? sym.name.replace(/_/g, '-');
    return base('cli', `command: ${name}`, /typer/i.test(block) ? 'typer' : 'click');
  }

  const event = EVENT_RE.exec(block);
  if (event) {
    return base('event', `on ${event[1]}`, 'fastapi');
  }

  const signal = SIGNAL_RE.exec(block);
  if (signal) {
    return base('signal', `when ${humanise(signal[1])}`, 'django');
  }

  return undefined;
}

function collectLocalPrefixes(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = new RegExp(ROUTER_DECL_RE.source, 'gm');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const prefix = PREFIX_RE.exec(m[2])?.[1];
    if (prefix) {
      out.set(m[1], prefix);
    }
  }
  return out;
}

/** Where a module's router gets mounted by whoever includes it. */
function collectMountPrefixes(files: ScannedFile[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of files) {
    const re = new RegExp(INCLUDE_RE.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(f.text))) {
      const dotted = m[1].split('.');
      const module = dotted.length > 1 ? dotted[dotted.length - 2] : dotted[0];
      out.set(module, m[2]);
    }
  }
  return out;
}

function moduleName(rel: string): string {
  return rel.replace(/\.py$/, '').split('/').pop() ?? rel;
}

function joinPath(...parts: string[]): string {
  const joined = parts
    .filter(Boolean)
    .map((p) => p.replace(/\/+$/, ''))
    .join('');
  const path = joined.replace(/\/{2,}/g, '/');
  return path.startsWith('/') ? path : `/${path}`;
}

function humanise(name: string): string {
  return name.replace(/[._-]+/g, ' ').trim();
}

/** Plain-language phrasing, for readers who do not think in routes and tasks. */
export function describeEntry(e: EntryPoint): string {
  switch (e.kind) {
    case 'http':
      return `someone calls ${e.label}`;
    case 'task':
      return `the ${e.label.replace('background job: ', '')} job runs`;
    case 'schedule':
      return `a scheduled job runs${e.detail ? ` (${e.detail})` : ''}`;
    case 'cli':
      return `someone runs ${e.label.replace('command: ', '')} on the command line`;
    case 'event':
      return `the app fires ${e.label}`;
    case 'signal':
      return e.label;
    case 'rpc':
      return `a client calls ${e.label.replace('rpc ', '')} over gRPC`;
    default:
      return e.label;
  }
}
