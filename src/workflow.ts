import { PySymbol } from './pythonScan';
import { Workflow, WorkflowStep, WorkflowInput } from './types';

/**
 * Workflow extraction: what this code actually does, in order.
 *
 * The call graph is the wrong shape for a request handler. "Calls get, commit,
 * NotFoundError" is debris — those are method calls on a session object, not
 * collaborators. What a reader needs is the sequence: who is allowed in, what is
 * loaded, what changes, what comes back, and how it can fail.
 *
 * All of it is read off the function body. Regex, not a parser — so it is
 * labelled as a best-effort reading, never as a guarantee.
 */

/** `db.query(Submission)`, `session.get(Submission, id)`, `select(Submission)` */
const READ_RE =
  /\b(?:\w+\.)?(?:query|get|select|scalar|scalars|execute)\s*\(\s*([A-Z]\w+)?|\bselect\s*\(\s*([A-Z]\w+)/;
const READ_VERB_RE = /\.(first|one|one_or_none|all|scalar|scalars|get)\s*\(/;
const FILTER_RE = /\.(filter|filter_by|where)\s*\(([^)]*)\)/;

const DB_RECEIVER_RE = /\b(db|session|sess|conn|connection|cursor|store|repo)\s*\./;
const APPEND_RE = /^\s*(\w+)\.(append|extend|add)\s*\(/;
const CALL_RE = /^([\w.]+)\s*\(/;
const LOOKUP_RE = /^[\w.]+\s*(?:\.get\s*\(|\[)/;
const BARE_CALL_RE = /^\s*([a-z_][\w.]*)\s*\(/;

const COMMIT_RE = /\.(commit|flush|save)\s*\(/;
const ADD_RE = /\.(add|add_all|bulk_save_objects)\s*\(\s*(\w+)?/;
const DELETE_RE = /\.delete\s*\(\s*(\w+)?/;
const ATTR_SET_RE = /^\s*(\w+)\.(\w+)\s*=\s*(.+?)\s*$/;

const ASSIGN_RE = /^\s*(\w+)\s*(?::[^=]+)?=\s*(.+?)\s*$/;
const FOR_RE = /^\s*(?:async\s+)?for\s+([\w, ]+?)\s+in\s+(.+?)\s*:\s*$/;
const COMP_RE = /^[\[{(]\s*.+?\s+for\s+(\w+)\s+in\s+([\w.()\[\]]+)(?:\s+if\s+(.+?))?\s*[\]})]/;
const AGG_RE = /^(sum|len|min|max|round|sorted|any|all|abs|count|mean|median)\s*\(\s*(.*)$/;
const WINDOW_RE = /(?:now|utcnow|today)\s*\(\s*\)\s*-\s*timedelta\s*\(\s*([^)]*)\)/;
const TERNARY_RE = /^(.+?)\s+if\s+(.+?)\s+else\s+(.+)$/;
const ARITH_RE = /[+\-*/%]|\bround\s*\(/;
const TRY_RE = /^\s*try\s*:\s*$/;
const EXCEPT_RE = /^\s*except\s+([\w.]+)/;

const RAISE_RE = /^\s*raise\s+(\w+)\s*\(?(.*)$/;
const STATUS_RE = /status_code\s*=\s*(?:status\.)?(\w+|\d{3})/;
const DETAIL_RE = /(?:detail|message)\s*=\s*['"]([^'"]{0,80})/;
const RETURN_RE = /^\s*return\s+(.*)$/;
const IF_RE = /^\s*(?:el)?if\s+(.+?):\s*$/;

const DEPENDS_RE = /(\w+)\s*(?::\s*[\w\[\], .]+)?\s*=\s*(?:Depends|Security)\s*\(\s*([\w.]*)\s*\)/g;

const BUILTIN_TYPES = new Set(['int', 'str', 'float', 'bool', 'UUID', 'datetime', 'date', 'dict', 'list']);

/** The signature, which may wrap across many lines. */
function signatureOf(lines: string[], sym: PySymbol): string {
  let acc = '';
  let depth = 0;
  for (let i = sym.startLine; i < lines.length && i <= sym.endLine; i++) {
    acc += lines[i];
    depth += (lines[i].match(/\(/g) ?? []).length - (lines[i].match(/\)/g) ?? []).length;
    if (depth <= 0 && acc.includes('(')) {
      break;
    }
    acc += ' ';
  }
  return acc;
}

function parseInputs(signature: string, routePath?: string): {
  requires: string[];
  inputs: WorkflowInput[];
} {
  const requires: string[] = [];
  const inputs: WorkflowInput[] = [];

  const inner = signature.slice(signature.indexOf('(') + 1, signature.lastIndexOf(')'));

  const dep = new RegExp(DEPENDS_RE.source, 'g');
  let m: RegExpExecArray | null;
  const depNames = new Set<string>();
  while ((m = dep.exec(inner))) {
    depNames.add(m[1]);
    requires.push(m[2] || m[1]);
  }

  // Split on top-level commas so untyped parameters are picked up too — plenty
  // of internal functions carry no annotations at all.
  const parts: string[] = [];
  let depth = 0;
  let buf = '';
  for (const ch of inner) {
    if (ch === '(' || ch === '[' || ch === '{') { depth++; }
    if (ch === ')' || ch === ']' || ch === '}') { depth--; }
    if (ch === ',' && depth === 0) { parts.push(buf); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim()) { parts.push(buf); }

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed || trimmed.startsWith('*')) {
      continue;
    }
    const nameMatch = /^(\w+)/.exec(trimmed);
    if (!nameMatch) {
      continue;
    }
    const name = nameMatch[1];
    // `db: Annotated[Session, Depends(get_db)]` is a dependency just as much as
    // `db: Session = Depends(get_db)`, and the modern style puts it inside the type.
    const inlineDep = /Depends\s*\(\s*([\w.]*)\s*\)/.exec(trimmed);
    if (inlineDep && !depNames.has(name)) {
      depNames.add(name);
      requires.push(inlineDep[1] || name);
      continue;
    }
    const type = /:\s*([\w\[\]., ]+)/.exec(trimmed)?.[1]?.trim() ?? '';
    const def = /=\s*(.+)$/.exec(trimmed)?.[1];
    if (name === 'self' || name === 'cls' || depNames.has(name)) {
      continue;
    }
    if (def && /Depends|Security/.test(def)) {
      continue;
    }
    const inPath = routePath ? routePath.includes(`{${name}}`) : false;
    const source: WorkflowInput['source'] = inPath
      ? 'path'
      : def && /Query\s*\(/.test(def)
        ? 'query'
        : !type || BUILTIN_TYPES.has(type)
          ? 'query'
          : 'body';
    inputs.push({ name, type: type || undefined, source });
  }
  return { requires, inputs };
}

export function buildWorkflow(
  text: string,
  sym: PySymbol,
  routePath?: string
): Workflow {
  const lines = text.split(/\r?\n/);
  const signature = signatureOf(lines, sym);
  const { requires, inputs } = parseInputs(signature, routePath);

  const steps: WorkflowStep[] = [];
  // The signature is joined into one string, so counting its newlines gave 1 and
  // the scan began inside a wrapped parameter list — turning `Depends(...)` into
  // a step. Find where the signature actually closes.
  let bodyStart = sym.startLine;
  let sigDepth = 0;
  do {
    const l = lines[bodyStart] ?? '';
    sigDepth += (l.match(/\(/g) ?? []).length - (l.match(/\)/g) ?? []).length;
    bodyStart++;
  } while (sigDepth > 0 && bodyStart <= sym.endLine);
  /** What each `except` clause ends up doing, folded into its own step. */
  const handlerOutcomes = new Map<WorkflowStep, string[]>();
  let pendingCondition: string | undefined;

  for (let i = Math.max(bodyStart, sym.startLine + 1); i <= sym.endLine && i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/#.*$/, '').trimEnd();
    if (!line.trim() || /^\s*("""|''')/.test(line)) {
      continue;
    }

    const cond = IF_RE.exec(line);
    if (cond) {
      pendingCondition = cond[1].trim();
      continue;
    }

    const raise = RAISE_RE.exec(line);
    if (raise) {
      // A raise directly under an `except` is that handler's outcome, not a
      // separate thing the function does. Folded in, the whole try/except tail
      // becomes one line instead of one per clause.
      const open = steps[steps.length - 1];
      if (open && open.kind === 'branch' && open.caught) {
        const status = STATUS_RE.exec(line)?.[1];
        const reraise = !raise[2].trim() && /^[a-z_]{1,4}$/.test(raise[1]);
        const outcome = reraise
          ? 'passes it on'
          : status
            ? `answers ${status}`
            : `fails with ${raise[1]}`;
        const list = handlerOutcomes.get(open) ?? [];
        if (!list.includes(outcome)) {
          list.push(outcome);
        }
        handlerOutcomes.set(open, list);
        open.label = handlerLabel(open.caught, list);
        pendingCondition = undefined;
        continue;
      }
      // `raise he` outside a handler is the same error travelling on, not a
      // new failure. Labelling it "fails (he)" told the reader nothing at all.
      if (!raise[2].trim() && /^[a-z_]{1,4}$/.test(raise[1])) {
        steps.push({ kind: 'error', label: 'passes the original error on', detail: line.trim(), line: i });
        pendingCondition = undefined;
        continue;
      }
      const status = STATUS_RE.exec(line)?.[1];
      const detail = DETAIL_RE.exec(line)?.[1];
      const why = pendingCondition ? `when ${humanCondition(pendingCondition)}` : undefined;
      steps.push({
        kind: 'error',
        label: `fails${status ? ` with ${status}` : `: ${humanExc(raise[1])}`}${why ? ` ${why}` : ''}`,
        detail: detail ?? raise[1],
        line: i
      });
      pendingCondition = undefined;
      continue;
    }

    const ret = RETURN_RE.exec(line);
    if (ret) {
      // A return under a condition is an early exit, which reads very differently
      // from the function's real answer at the end.
      const value = describeReturn(ret[1]);
      const guarded = pendingCondition
        ? `stops early when ${humanCondition(pendingCondition)}, returning ${shorten(value, 30)}`
        : `returns ${value}`;
      steps.push({ kind: pendingCondition ? 'branch' : 'return', label: guarded, detail: line.trim(), line: i });
      pendingCondition = undefined;
      continue;
    }

    if (TRY_RE.test(line)) {
      pendingCondition = undefined;
      continue; // the interesting part is the except, below
    }
    const exc = EXCEPT_RE.exec(line);
    if (exc) {
      // A tail of `except A: ... except B: ... except Exception: ...` was
      // producing five steps that between them said "it has error handling".
      // They collapse into one, which is the whole of what a reader needs.
      const prev = steps[steps.length - 1];
      if (prev && prev.kind === 'branch' && prev.caught) {
        prev.caught.push(exc[1]);
        prev.label = handlerLabel(prev.caught, handlerOutcomes.get(prev) ?? []);
        continue;
      }
      steps.push({
        kind: 'branch',
        label: handlerLabel([exc[1]], []),
        detail: line.trim(),
        line: i,
        caught: [exc[1]]
      });
      continue;
    }
    const loop = FOR_RE.exec(line);
    if (loop) {
      steps.push({
        kind: 'loop',
        label: `goes through each ${shorten(loop[2].replace(/[():]/g, '').trim(), 30)}`,
        detail: line.trim(),
        line: i
      });
      pendingCondition = undefined;
      continue;
    }

    // Only a database-shaped receiver counts. `_PENDING.get(token)` is a dict
    // lookup, and calling it a database read was actively misleading.
    const isDbRead =
      /\.query\s*\(/.test(line) ||
      /\bselect\s*\(/.test(line) ||
      (DB_RECEIVER_RE.test(line) && READ_VERB_RE.test(line));
    if (isDbRead) {
      const model = READ_RE.exec(line);
      const name = model?.[1] ?? model?.[2];
      const filter = FILTER_RE.exec(line)?.[2]?.trim();
      const into = ASSIGN_RE.exec(line)?.[1];
      const what = name ?? (into ? plural(into) : undefined);
      steps.push({
        kind: 'read',
        label: what
          ? `looks up ${what}${filter ? ` by ${shorten(filter, 34)}` : ''}`
          : 'reads from the database',
        detail: line.trim(),
        line: i
      });
      pendingCondition = undefined;
      continue;
    }

    const add = ADD_RE.exec(line);
    if (add) {
      steps.push({ kind: 'write', label: `adds ${add[2] ?? 'a record'}`, detail: line.trim(), line: i });
      continue;
    }
    const del = DELETE_RE.exec(line);
    if (del) {
      steps.push({ kind: 'write', label: `deletes ${del[1] ?? 'a record'}`, detail: line.trim(), line: i });
      continue;
    }
    if (COMMIT_RE.test(line)) {
      steps.push({ kind: 'write', label: 'saves the change', detail: line.trim(), line: i });
      continue;
    }

    // Pure-logic code: windows, filters, aggregates, arithmetic, either/or choices.
    const assign = ASSIGN_RE.exec(line);
    if (assign && !line.includes('==')) {
      const [, target, rhs] = assign;
      const computed = describeAssignment(target, rhs);
      if (computed) {
        steps.push({ kind: computed.kind, label: computed.label, detail: line.trim(), line: i });
        pendingCondition = undefined;
        continue;
      }
      // A call assigned to a name is the backbone of orchestration code, and
      // the function's own name is usually the best description available.
      const called = CALL_RE.exec(rhs)?.[1];
      if (called && !BUILTIN_CALLS.has(called.split('.').pop() ?? '')) {
        const store = describeStoreAccess(called, rhs, target);
        steps.push(
          store
            ? { kind: 'read', label: store, detail: line.trim(), line: i }
            : { kind: 'call', label: verbalise(called), detail: line.trim(), line: i }
        );
        pendingCondition = undefined;
        continue;
      }
      if (LOOKUP_RE.test(rhs)) {
        steps.push({ kind: 'read', label: `looks up ${plural(target)}`, detail: line.trim(), line: i });
        pendingCondition = undefined;
        continue;
      }
    }

    const bare = BARE_CALL_RE.exec(line);
    if (bare && !BUILTIN_CALLS.has(bare[1].split('.').pop() ?? '')) {
      steps.push({ kind: 'call', label: verbalise(bare[1]), detail: line.trim(), line: i });
      pendingCondition = undefined;
      continue;
    }

    const app = APPEND_RE.exec(line);
    if (app) {
      steps.push({ kind: 'compute', label: `adds to ${plural(app[1])}`, detail: line.trim(), line: i });
      pendingCondition = undefined;
      continue;
    }

    const set = ATTR_SET_RE.exec(line);
    if (set && !set[1].match(/^(self|cls)$/)) {
      steps.push({
        kind: 'write',
        label: `sets ${set[2]} to ${shorten(set[3], 30)}`,
        detail: line.trim(),
        line: i
      });
      continue;
    }
  }

  return {
    trigger: routePath,
    requires,
    inputs,
    steps: dedupe(steps).slice(0, 14),
    confidence: 'heuristic'
  };
}

/**
 * Turn an assignment into a sentence, or return nothing rather than narrate
 * bookkeeping. Ordered most specific first: a time window reads better as a
 * window than as arithmetic.
 */
function describeAssignment(
  target: string,
  rhs: string
): { kind: WorkflowStep['kind']; label: string } | undefined {
  const window = WINDOW_RE.exec(rhs);
  if (window) {
    // `days=90` reads as "90 days", not "days 90".
    const span = window[1]
      .split(',')
      .map((part) => {
        const [unit, value] = part.split('=').map((x) => x.trim());
        return value ? `${value} ${unit}` : unit;
      })
      .join(' ');
    return { kind: 'compute', label: `works out a cut-off ${shorten(span, 24)} back` };
  }

  const comp = COMP_RE.exec(rhs);
  if (comp) {
    const [, , iterable, cond] = comp;
    return cond
      ? { kind: 'filter', label: `keeps only the ${plural(iterable)} where ${humanCondition(cond)}` }
      : { kind: 'compute', label: `builds ${plural(target)} from each ${plural(iterable)}` };
  }

  const agg = AGG_RE.exec(rhs);
  if (agg) {
    const verb: Record<string, string> = {
      sum: 'adds up',
      len: 'counts',
      count: 'counts',
      min: 'takes the smallest of',
      max: 'takes the largest of',
      sorted: 'sorts',
      any: 'checks whether any of',
      all: 'checks whether all of',
      round: 'rounds',
      abs: 'takes the size of',
      mean: 'averages',
      median: 'takes the middle of'
    };
    return {
      kind: 'compute',
      label: `${verb[agg[1]] ?? 'works out'} ${shorten(agg[2].replace(/\)+$/, ''), 30)} as ${plural(target)}`
    };
  }

  const tern = TERNARY_RE.exec(rhs);
  if (tern) {
    return { kind: 'branch', label: `sets ${plural(target)} depending on whether ${humanCondition(tern[2])}` };
  }

  if (ARITH_RE.test(rhs) && rhs.length < 120) {
    return { kind: 'compute', label: `works out ${plural(target)}` };
  }
  return undefined;
}

const BUILTIN_CALLS = new Set([
  'print', 'len', 'str', 'int', 'float', 'bool', 'list', 'dict', 'set', 'tuple',
  'range', 'enumerate', 'zip', 'isinstance', 'getattr', 'setattr', 'super', 'open',
  'format', 'join', 'split', 'strip', 'append', 'get', 'items', 'keys', 'values',
  // Shape conversions. `user_doc.to_dict()` is not a step in anyone's mental
  // model of what the function does; it is how Python spells the same object.
  'to_dict', 'to_json', 'dict', 'json', 'model_dump', 'model_dump_json', 'dump',
  'isoformat', 'lower', 'upper', 'startswith', 'endswith', 'replace'
]);

/**
 * `db.collection("users")` verbalised to the single word "collection", which
 * names the API and not the intent. The literal in the call is the useful half.
 */
const STORE_CALLS = new Set(['collection', 'document', 'doc', 'table', 'ref', 'child', 'node', 'bucket']);
const LITERAL_ARG_RE = /\(\s*['"]([^'"]{1,40})['"]/;

function describeStoreAccess(called: string, rhs: string, target: string): string | undefined {
  const tail = called.split('.').pop() ?? called;
  if (!STORE_CALLS.has(tail)) {
    return undefined;
  }
  const literal = LITERAL_ARG_RE.exec(rhs)?.[1];
  if (literal) {
    return `opens the ${literal} ${tail === 'doc' ? 'document' : tail}`;
  }
  return `looks up the ${plural(target)}`;
}

/** `return {` is the start of a literal, not a value worth quoting. */
function describeReturn(raw: string): string {
  const v = raw.trim();
  if (!v || v === '{' || (v.startsWith('{') && !v.includes('}'))) {
    return 'the details it gathered';
  }
  if (v === '[' || (v.startsWith('[') && !v.includes(']'))) {
    return 'the list it built';
  }
  if (v === '(' || (v.startsWith('(') && !v.includes(')'))) {
    return 'the values it assembled';
  }
  return shorten(v);
}

/** `UserNotFoundException` → `user not found`: the name already said it. */
function humanExc(name: string): string {
  const bare = (name.split('.').pop() ?? name).replace(/(Exception|Error)$/, '');
  if (!bare) {
    return name;
  }
  const words = bare.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words === 'http' ? name : words;
}

/** `firebase_auth.ExpiredIdTokenError` → `ExpiredIdTokenError`. */
function shortExc(name: string): string {
  return name.split('.').pop() ?? name;
}

function handlerLabel(caught: string[], outcomes: string[]): string {
  const what = listOf(caught);
  if (!outcomes.length) {
    return `handles ${what}`;
  }
  const how = outcomes.slice(0, 3).join(' or ');
  return `handles ${what} — ${how}`;
}

function listOf(names: string[]): string {
  const short = names.map(shortExc);
  const generic = short.some((n) => n === 'Exception' || n === 'BaseException');
  const named = short.filter((n) => n !== 'Exception' && n !== 'BaseException');
  if (!named.length) {
    return 'any error';
  }
  const head = named.slice(0, 2).join(' or ');
  const rest = named.length > 2 ? ` and ${named.length - 2} more` : '';
  return `${head}${rest}${generic ? ', or any other error' : ''}`;
}

/** `_find_or_create_guest` is already a sentence; it just needs spaces. */
function verbalise(call: string): string {
  const name = call.split('.').pop() ?? call;
  return name.replace(/^_+/, '').replace(/_/g, ' ').trim() || call;
}

/** `payments` reads better than `payments`; `payment_list` better as `payments`. */
function plural(name: string): string {
  return name
    .replace(/^_+/, '')
    .replace(/_(list|set|rows|items|results?|data)$/, '')
    .replace(/_/g, ' ');
}

/** Consecutive identical labels are almost always a loop body read twice. */
function dedupe(steps: WorkflowStep[]): WorkflowStep[] {
  return steps.filter((s, i) => i === 0 || s.label !== steps[i - 1].label);
}

function shorten(s: string, n = 44): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** `not submission` reads better as "it is missing". */
function humanCondition(cond: string): string {
  const c = cond.trim();
  const negatedExists = /^not\s+([\w.]+)\.(exists|is_valid|ok|success)$/.exec(c);
  if (negatedExists) {
    return `there is no ${plural(negatedExists[1].split('.').pop() ?? negatedExists[1])}`;
  }
  if (/^not\s+[\w.]+$/.test(c)) {
    return `${plural((c.replace(/^not\s+/, '').split('.').pop()) ?? c)} is missing`;
  }
  if (/is\s+None$/.test(c)) {
    return `${c.replace(/\s*is\s+None$/, '')} is missing`;
  }
  return shorten(c, 40);
}
