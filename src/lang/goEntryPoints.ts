import { EntryKind, EntryPoint } from '../types';
import { CodeSymbol, EntryPointIndex, ScannedFile, entryKey } from './types';
import { goImports, maskGo } from './goSyntax';

/**
 * Go entry points.
 *
 * Python frameworks mark a handler where it is defined, with a decorator. Go
 * frameworks register it somewhere else — `r.GET("/users/:id", h.GetUser)` in a
 * setup function — so each registration has to be traced back to the function
 * it names. Route prefixes accumulate through router variables (`api :=
 * r.Group("/api")`) and, for chi, through nested `Route` closures whose router
 * parameter shadows the outer one.
 */

const METHOD_ROUTE_RE =
  /(\w+)\s*\.\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Any|Get|Post|Put|Patch|Delete|Head|Options)\s*\(\s*"([^"]*)"\s*,\s*(.+)\)\s*;?\s*$/;
const HANDLE_RE = /(\w+)\s*\.\s*(HandleFunc|Handle)\s*\(\s*"([^"]*)"\s*,\s*(.+?)\)\s*(?:\.\s*Methods\s*\(([^)]*)\))?\s*;?\s*$/;
const GROUP_RE = /(\w+)\s*:?=\s*(\w+)\s*\.\s*Group\s*\(\s*"([^"]*)"/;
const SUBROUTER_RE = /(\w+)\s*:?=\s*(\w+)\s*\.\s*PathPrefix\s*\(\s*"([^"]*)"\s*\)\s*\.\s*Subrouter\s*\(\s*\)/;
const CHI_ROUTE_RE = /(\w+)\s*\.\s*Route\s*\(\s*"([^"]*)"\s*,\s*func\s*\(\s*(\w+)/;
const CRON_RE = /\.\s*AddFunc\s*\(\s*"([^"]+)"\s*,\s*([\w.]+)\s*\)/;
const GOCRON_RE = /\.\s*Every\s*\(([^)]*)\)[^;\n]*?\.\s*Do\s*\(\s*([\w.]+)/;
const GRPC_RE =
  /\(\s*\w+\s+context\.Context\s*,\s*\w+\s+\*\w+\.(\w+)\s*\)\s*\(\s*\*\w+\.\w+\s*,\s*error\s*\)/;

/** Wrappers that take the real handler as their argument. */
const WRAPPERS = /^(http\.HandlerFunc|http\.StripPrefix|http\.TimeoutHandler|otelhttp\.NewHandler)$/;

function dirOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i === -1 ? '' : rel.slice(0, i);
}

function joinPath(...parts: string[]): string {
  const joined = parts.filter(Boolean).map((p) => p.replace(/\/+$/, '')).join('');
  const path = joined.replace(/\/{2,}/g, '/');
  return path.startsWith('/') ? path : `/${path}`;
}

/** The last top-level argument of an argument list — the handler, after any middleware. */
function lastArg(args: string): string {
  let depth = 0;
  let start = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if ('([{'.includes(c)) {
      depth++;
    } else if (')]}'.includes(c)) {
      depth--;
    } else if (c === ',' && depth === 0) {
      start = i + 1;
    }
  }
  return args.slice(start).trim();
}

/**
 * What a handler expression names: `h.GetUser` → GetUser (a method),
 * `handlers.List` → List in package handlers, `http.HandlerFunc(x)` → x.
 * Inline closures name nothing.
 */
function handlerRef(expr: string): { qualifier?: string; name: string } | undefined {
  let e = expr.trim().replace(/^&/, '');
  for (let guard = 0; guard < 4; guard++) {
    if (/^func\b/.test(e)) {
      return undefined;
    }
    const wrapped = /^([\w.]+)\s*\(([\s\S]*)\)$/.exec(e);
    if (wrapped && WRAPPERS.test(wrapped[1])) {
      e = lastArg(wrapped[2]);
      continue;
    }
    break;
  }
  const m = /^(?:([A-Za-z_]\w*)\s*\.\s*)?([A-Za-z_]\w*)\s*(?:\(\s*\))?$/.exec(e);
  return m ? { qualifier: m[1], name: m[2] } : undefined;
}

interface Located {
  file: ScannedFile;
  sym: CodeSymbol;
}

/** Find the function or method a registration names, preferring the most specific match. */
function locate(
  ref: { qualifier?: string; name: string },
  from: ScannedFile,
  files: ScannedFile[]
): Located | undefined {
  const candidates: Located[] = [];
  for (const f of files) {
    for (const sym of f.symbols) {
      if (sym.name === ref.name && sym.kind !== 'class') {
        candidates.push({ file: f, sym });
      }
    }
  }
  if (!candidates.length) {
    return undefined;
  }
  if (ref.qualifier) {
    const path = goImports(from.text).get(ref.qualifier);
    if (path) {
      const inPkg = candidates.find((c) => {
        const dir = dirOf(c.file.rel);
        return c.sym.kind === 'function' && !!dir && (path === dir || path.endsWith(`/${dir}`));
      });
      if (inPkg) {
        return inPkg;
      }
    }
    // `h.GetUser`: a method value — any method of that name.
    return candidates.find((c) => c.sym.kind === 'method') ?? candidates[0];
  }
  return (
    candidates.find((c) => dirOf(c.file.rel) === dirOf(from.rel) && c.sym.kind === 'function') ??
    candidates.find((c) => c.sym.kind === 'function') ??
    candidates[0]
  );
}

function entryFor(
  at: Located,
  kind: EntryKind,
  label: string,
  framework: string,
  detail?: string
): EntryPoint {
  return {
    kind,
    label,
    framework,
    detail,
    symbol: {
      name: at.sym.name,
      qualified: at.sym.qualified,
      file: at.file.rel,
      line: at.sym.startLine,
      confidence: 'resolved',
      reason: `${framework} ${kind} entry point`
    }
  };
}

function frameworkOf(text: string): string {
  const imports = [...goImports(text).values()].join(' ');
  if (/gin-gonic\/gin/.test(imports)) {
    return 'gin';
  }
  if (/labstack\/echo/.test(imports)) {
    return 'echo';
  }
  if (/go-chi\/chi/.test(imports)) {
    return 'chi';
  }
  if (/gofiber\/fiber/.test(imports)) {
    return 'fiber';
  }
  if (/gorilla\/mux/.test(imports)) {
    return 'gorilla/mux';
  }
  return 'net/http';
}

export function scanGoEntryPoints(files: ScannedFile[]): EntryPointIndex {
  const index: EntryPointIndex = new Map();
  const add = (e: EntryPoint) => {
    const key = entryKey(e.symbol.file, e.symbol.line);
    if (!index.has(key)) {
      index.set(key, e);
    }
  };

  for (const f of files) {
    const orig = f.text.split(/\r?\n/);
    const masked = maskGo(f.text).split(/\r?\n/);
    const framework = frameworkOf(f.text);

    // Router variable → the path prefix it carries. Chi's nested Route closures
    // shadow the variable, so their prefixes live on a stack keyed by depth.
    const prefixes = new Map<string, string>();
    const scopes: { depth: number; name: string; previous: string | undefined }[] = [];
    let depth = 0;

    for (let i = 0; i < orig.length; i++) {
      const line = orig[i];
      let m: RegExpExecArray | null;

      if ((m = GROUP_RE.exec(line)) || (m = SUBROUTER_RE.exec(line))) {
        prefixes.set(m[1], joinPath(prefixes.get(m[2]) ?? '', m[3]));
      }
      if ((m = CHI_ROUTE_RE.exec(line))) {
        const [, outer, path, inner] = m;
        scopes.push({ depth: depth + 1, name: inner, previous: prefixes.get(inner) });
        prefixes.set(inner, joinPath(prefixes.get(outer) ?? '', path));
      }

      if ((m = METHOD_ROUTE_RE.exec(line))) {
        const [, router, verb, path, args] = m;
        const ref = handlerRef(lastArg(args));
        const at = ref && (path.startsWith('/') || path === '') ? locate(ref, f, files) : undefined;
        if (at) {
          const method = verb.toUpperCase() === 'ANY' ? 'ANY' : verb.toUpperCase();
          add(entryFor(at, 'http', `${method} ${joinPath(prefixes.get(router) ?? '', path)}`, framework));
        }
      } else if ((m = HANDLE_RE.exec(line))) {
        const [, router, , rawPattern, handler, methodList] = m;
        // Go 1.22 patterns carry the method: "GET /items/{id}".
        const pattern = /^([A-Z]+)\s+(\S+)$/.exec(rawPattern);
        const methods = pattern
          ? pattern[1]
          : methodList
            ? methodList.replace(/["\s]/g, '').split(',').filter(Boolean).join('/')
            : 'ANY';
        const path = pattern ? pattern[2] : rawPattern;
        const ref = handlerRef(handler);
        const at = ref && path.startsWith('/') ? locate(ref, f, files) : undefined;
        if (at) {
          // `http.HandleFunc` is the standard library whatever else the file imports.
          add(entryFor(at, 'http', `${methods} ${joinPath(prefixes.get(router) ?? '', path)}`, router === 'http' ? 'net/http' : framework));
        }
      }

      if ((m = CRON_RE.exec(line))) {
        const ref = handlerRef(m[2]);
        const at = ref && locate(ref, f, files);
        if (at) {
          add(entryFor(at, 'schedule', `scheduled: ${at.sym.name}`, 'cron', `runs ${m[1]}`));
        }
      } else if ((m = GOCRON_RE.exec(line))) {
        const ref = handlerRef(m[2]);
        const at = ref && locate(ref, f, files);
        if (at) {
          add(entryFor(at, 'schedule', `scheduled: ${at.sym.name}`, 'gocron', `every ${m[1].trim()}`));
        }
      }

      // Brace depth from masked text, after the line's own openings are counted.
      for (const ch of masked[i]) {
        if (ch === '{') {
          depth++;
        } else if (ch === '}') {
          depth--;
          while (scopes.length && depth < scopes[scopes.length - 1].depth) {
            const s = scopes.pop()!;
            if (s.previous === undefined) {
              prefixes.delete(s.name);
            } else {
              prefixes.set(s.name, s.previous);
            }
          }
        }
      }
    }

    // Cobra: `Use: "serve"` with `Run: runServe` (or RunE) in the same Command literal.
    const cobra = /cobra\.Command\s*\{([\s\S]*?)\n\s*\}/g;
    let c: RegExpExecArray | null;
    while ((c = cobra.exec(f.text))) {
      const use = /\bUse\s*:\s*"([^"\s]+)/.exec(c[1])?.[1];
      const run = /\bRunE?\s*:\s*([\w.]+)\s*,?\s*$/m.exec(c[1])?.[1];
      const ref = run && handlerRef(run);
      const at = ref && locate(ref, f, files);
      if (use && at) {
        add(entryFor(at, 'cli', `command: ${use}`, 'cobra'));
      }
    }

    // gRPC: a method with the generated (ctx, *pb.XRequest) (*pb.XResponse, error) shape.
    for (const sym of f.symbols) {
      if (sym.kind === 'method') {
        const signature = orig.slice(sym.startLine, sym.startLine + 3).join(' ');
        if (GRPC_RE.test(signature)) {
          add(entryFor({ file: f, sym }, 'rpc', `rpc ${sym.name}`, 'grpc'));
        }
      }
    }

    // main() in package main is where the program starts.
    if (/^package\s+main\b/m.test(f.text)) {
      const main = f.symbols.find((s) => s.name === 'main' && s.kind === 'function');
      if (main) {
        const name = dirOf(f.rel).split('/').pop() || 'main';
        add(entryFor({ file: f, sym: main }, 'cli', `program start: ${name}`, 'go'));
      }
    }
  }
  return index;
}
