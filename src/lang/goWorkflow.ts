import { Workflow, WorkflowInput, WorkflowStep } from '../types';
import { dedupe, shorten } from '../workflow';
import { CodeSymbol } from './types';
import { maskGo } from './goSyntax';

/**
 * A Go function body, read as ordered steps.
 *
 * Go's shape differs from Python's in one way that matters: almost every call
 * is followed by `if err != nil { return … }`. Listing each of those as its own
 * step would bury the work under error plumbing, so a check that only passes
 * the failure on folds into the step it guards ("finds the user, or stops if
 * that fails"). A check that answers an HTTP status keeps what it answers.
 */

const STATUS: Record<string, string> = {
  OK: '200', Created: '201', Accepted: '202', NoContent: '204', BadRequest: '400',
  Unauthorized: '401', PaymentRequired: '402', Forbidden: '403', NotFound: '404', MethodNotAllowed: '405', Conflict: '409',
  Gone: '410', PreconditionFailed: '412', RequestEntityTooLarge: '413', UnprocessableEntity: '422', TooManyRequests: '429', InternalServerError: '500',
  NotImplemented: '501', BadGateway: '502', ServiceUnavailable: '503'
};

/** Calls that are plumbing, not steps anyone would describe. */
const NOISE = /^(fmt\.(Sprintf|Sprint|Sprintln|Errorf)|strconv\.|strings\.|bytes\.|time\.(Now|Since|Duration)|errors\.(Is|As|New|Unwrap)|log\.|slog\.|logger\.|zap\.|context\.|json\.Marshal|sort\.|math\.|filepath\.|path\.|utf8\.|sync\.)|(^|\.)(LastInsertId|RowsAffected|Close|Err|Next|Scan|Error|String)$/;
/** Framework response writers: gin, echo, fiber, chi's render. */
const RESPONSE_RE = /^\w+\s*\.\s*(JSON|IndentedJSON|PureJSON|String|XML|HTML|Data|Status|SendStatus|NoContent|Redirect|AbortWithStatus|AbortWithStatusJSON|Render)\s*\(\s*([^,)]*)\s*,?\s*([\w.]*)/;
const DB_RECEIVER = /\b(db|tx|conn|pool|DB|sqlDB|gormDB)\s*\.\s*$/;
const DB_READ = /\b(?:db|tx|conn|pool|DB)\w*\s*\.\s*(Query|QueryRow|QueryContext|QueryRowContext|Get|GetContext|Select|SelectContext|Find|First|Last|Take|Where|Model|Raw)\s*\(/;
const DB_WRITE = /\b(?:db|tx|conn|pool|DB)\w*\s*\.\s*(Exec|ExecContext|Create|Save|Update|Updates|Delete|NamedExec)\s*\(/;
const SQL_TABLE = /\b(?:FROM|INTO|UPDATE|JOIN)\s+["`]?([A-Za-z_][\w.]*)/i;
const SQL_VERB = /^\s*["`]?\s*(SELECT|INSERT|UPDATE|DELETE)\b/i;

function status(expr: string): string | undefined {
  const named = /http\.Status(\w+)/.exec(expr);
  if (named) {
    return STATUS[named[1]] ?? named[1];
  }
  return /\b([1-5]\d\d)\b/.exec(expr)?.[1];
}

/** `GetUserByID` and `svc.GetUserByID` both read as "get user by id". */
function verbaliseGo(call: string): string {
  const name = call.split('.').pop() ?? call;
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .replace(/\bi d\b/g, 'id')
    .trim() || call;
}

/** The first comma-separated value, ignoring commas inside brackets. */
function firstTopLevel(expr: string): string {
  let depth = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if ('([{'.includes(ch)) { depth++; }
    else if (')]}'.includes(ch)) { depth--; }
    else if (ch === ',' && depth === 0) { return expr.slice(0, i).trim(); }
  }
  return expr.trim();
}

/** `userList` or `users` → "users"; `u` stays `u`. */
function pluralGo(name: string): string {
  return name
    .replace(/(List|Slice|Items|Rows|Map)$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase();
}

function humanGoCondition(raw: string): string {
  let c = raw.trim();
  if (/^\(.*\)$/.test(c) && !/\)\s*\(/.test(c)) {
    c = c.slice(1, -1).trim();
  }
  let m: RegExpExecArray | null;
  if ((m = /^errors\.Is\(\s*\w+\s*,\s*([\w.]+)\s*\)$/.exec(c))) {
    return /NoRows|NotFound|ErrNotExist|RecordNotFound/.test(m[1]) ? 'nothing is found' : `the error is ${m[1].split('.').pop()}`;
  }
  if ((m = /^([\w.]+)\s*==\s*nil$/.exec(c))) {
    return `${pluralGo(m[1].split('.').pop()!)} is missing`;
  }
  if ((m = /^([\w.]+)\s*!=\s*nil$/.exec(c))) {
    return `${pluralGo(m[1].split('.').pop()!)} is set`;
  }
  if ((m = /^len\(([\w.]+)\)\s*==\s*0$/.exec(c))) {
    return `${pluralGo(m[1].split('.').pop()!)} is empty`;
  }
  if ((m = /^([\w.]+)\s*==\s*""$/.exec(c))) {
    return `${pluralGo(m[1].split('.').pop()!)} is empty`;
  }
  if (c === '!ok') {
    return 'it is not found';
  }
  if ((m = /^!([\w.]+)$/.exec(c))) {
    return `not ${pluralGo(m[1].split('.').pop()!)}`;
  }
  return shorten(c, 40);
}

/** The closing line of a block opened on `line`, by brace depth on masked text. */
function blockEnd(masked: string[], line: number, limit: number): number {
  let depth = 0;
  for (let i = line; i <= limit; i++) {
    for (const ch of masked[i]) {
      if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) {
          return i;
        }
      }
    }
  }
  return limit;
}

/** What a block does when it ends early: the status it answers, or that it stops. */
function outcomeOf(orig: string[], from: number, to: number): { outcome: string; answers?: string } {
  for (let i = from; i <= to; i++) {
    const l = orig[i];
    const httpErr = /http\.Error\(\s*\w+\s*,\s*(.+?),\s*([^)]+)\)/.exec(l);
    if (httpErr) {
      const code = status(httpErr[2]);
      return { outcome: `answers ${code ?? 'an error'}`, answers: code };
    }
    const resp = /\.(JSON|String|AbortWithStatus|AbortWithStatusJSON|AbortWithError|Status|SendStatus|NoContent)\s*\(([^,)]*)/.exec(l);
    if (resp) {
      const code = status(resp[2]);
      if (code) {
        return { outcome: `answers ${code}`, answers: code };
      }
    }
    const wh = /WriteHeader\(([^)]+)\)/.exec(l);
    if (wh && status(wh[1])) {
      return { outcome: `answers ${status(wh[1])}`, answers: status(wh[1]) };
    }
    if (/\blog\.Fatal|\bos\.Exit\(|\bpanic\(/.test(l)) {
      return { outcome: 'stops the program' };
    }
  }
  return { outcome: 'stops' };
}

function parseParams(signature: string): { name: string; type: string }[] {
  const open = signature.indexOf('(', signature.search(/\)\s*[A-Za-z_]\w*\s*\(|func\s+[A-Za-z_]\w*\s*\(/) + 1);
  if (open < 0) {
    return [];
  }
  let depth = 0;
  let end = open;
  for (let i = open; i < signature.length; i++) {
    if (signature[i] === '(' || signature[i] === '[') {
      depth++;
    } else if (signature[i] === ')' || signature[i] === ']') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const inner = signature.slice(open + 1, end);
  const parts: string[] = [];
  let buf = '';
  depth = 0;
  for (const ch of inner) {
    if ('([{'.includes(ch)) {
      depth++;
    } else if (')]}'.includes(ch)) {
      depth--;
    }
    if (ch === ',' && depth === 0) {
      parts.push(buf.trim());
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) {
    parts.push(buf.trim());
  }
  // `a, b string` shares a type: walk right to left, carrying the last type seen.
  const out: { name: string; type: string }[] = [];
  let carried = '';
  for (let i = parts.length - 1; i >= 0; i--) {
    const m = /^([A-Za-z_]\w*)\s+(.+)$/.exec(parts[i]);
    if (m) {
      carried = m[2];
      out.unshift({ name: m[1], type: m[2] });
    } else if (carried && /^[A-Za-z_]\w*$/.test(parts[i])) {
      out.unshift({ name: parts[i], type: carried });
    }
  }
  return out;
}

export function buildGoWorkflow(text: string, sym: CodeSymbol): Workflow {
  const orig = text.split(/\r?\n/);
  const masked = maskGo(text).split(/\r?\n/);

  // The signature runs from `func` to the line holding the body's `{`.
  let bodyStart = sym.startLine;
  while (bodyStart < sym.endLine && !masked[bodyStart].includes('{')) {
    bodyStart++;
  }
  const signature = orig.slice(sym.startLine, bodyStart + 1).join(' ');
  const params = parseParams(signature);

  const requires = new Set<string>();
  const inputs: WorkflowInput[] = [];
  let trigger: string | undefined;
  for (const p of params) {
    if (/http\.ResponseWriter|\*http\.Request|gin\.Context|echo\.Context|fiber\.Ctx/.test(p.type)) {
      trigger = 'http';
    } else if (/context\.Context/.test(p.type)) {
      // every Go call takes one; naming it says nothing
    } else if (/\bDB\b|sql\.|gorm|Repo|Store|Querier|Tx\b|pgx/.test(p.type)) {
      requires.add(`${p.name} (database)`);
    } else if (/Client$|Service$|Logger$/.test(p.type.replace(/^\*/, ''))) {
      requires.add(p.name);
    } else {
      inputs.push({ name: p.name, type: p.type, source: 'body' });
    }
  }

  const steps: WorkflowStep[] = [];
  let pendingCondition: string | undefined;
  // An `if` without a return colours the first step inside it. When its body
  // holds no step (`subtotal -= discount`), say what it changes instead, so the
  // condition can't leak onto whatever comes after the block.
  let pendingEnd = -1;
  let pendingFallback: string | undefined;
  const flushPending = () => {
    if (pendingCondition && pendingFallback) {
      push({ kind: 'compute', label: pendingFallback, line: pendingEnd });
    }
    pendingCondition = undefined;
    pendingFallback = undefined;
  };
  const push = (step: WorkflowStep) => {
    if (pendingCondition && step.kind !== 'error' && step.kind !== 'return') {
      step.label = `when ${pendingCondition}, ${step.label}`;
    }
    pendingCondition = undefined;
    steps.push(step);
  };

  const describeCall = (call: string, line: string, i: number): WorkflowStep | undefined => {
    let m: RegExpExecArray | null;
    if ((m = /\.Param\(\s*"([^"]+)"/.exec(line)) || (m = /URLParam\(\s*\w+\s*,\s*"([^"]+)"/.exec(line)) ||
        (m = /PathValue\(\s*"([^"]+)"/.exec(line)) || (m = /mux\.Vars\(\s*\w+\s*\)\[\s*"([^"]+)"/.exec(line))) {
      if (!inputs.some((x) => x.name === m![1])) {
        inputs.push({ name: m[1], source: 'path' });
      }
      return { kind: 'read', label: `reads ${m[1]} from the URL`, line: i };
    }
    if ((m = /\.(?:Query|QueryParam|FormValue|DefaultQuery)\(\s*"([^"]+)"/.exec(line)) && !DB_RECEIVER.test(line.split(/\.(?:Query|QueryParam)/)[0])) {
      if (!inputs.some((x) => x.name === m![1])) {
        inputs.push({ name: m[1], source: 'query' });
      }
      return { kind: 'read', label: `reads ${m[1]} from the query string`, line: i };
    }
    if (/\.(ShouldBindJSON|BindJSON|ShouldBind|Bind|BodyParser)\(|json\.NewDecoder\([^)]*Body/.test(line)) {
      const into = /\(\s*&?(\w+)\s*\)\s*;?\s*(err|$)/.exec(line.slice(line.lastIndexOf('(')))?.[1] ?? /&(\w+)/.exec(line)?.[1];
      if (into && !inputs.some((x) => x.name === into)) {
        inputs.push({ name: into, source: 'body' });
      }
      return { kind: 'read', label: `reads the request body${into ? ` into ${into}` : ''}`, line: i };
    }
    if (NOISE.test(call)) {
      return undefined;
    }
    if (DB_READ.test(line)) {
      const sql = SQL_TABLE.exec(line)?.[1];
      const target = /\(\s*&(\w+)/.exec(line)?.[1];
      return { kind: 'read', label: sql ? `reads ${sql} from the database` : `looks up ${target ? pluralGo(target) : 'records'} in the database`, line: i };
    }
    if (DB_WRITE.test(line)) {
      const verb = SQL_VERB.exec(/"[^"]*"|`[^`]*`/.exec(line)?.[0] ?? '')?.[1]?.toUpperCase();
      const table = SQL_TABLE.exec(line)?.[1];
      const target = /\(\s*&?(\w+)/.exec(line.slice(line.search(DB_WRITE)))?.[1];
      const op = /\.(\w+)\s*\(/.exec(line.slice(line.search(DB_WRITE)))?.[1] ?? '';
      const word =
        verb === 'INSERT' || op === 'Create' ? 'adds' :
        verb === 'DELETE' || op === 'Delete' ? 'removes' : 'updates';
      const what = table ?? (target && target !== 'ctx' ? pluralGo(target) : 'records');
      const phrase = word === 'adds' ? `adds to ${what}` : word === 'removes' ? `removes from ${what}` : `updates ${what}`;
      return { kind: 'write', label: `${phrase} in the database`, line: i };
    }
    if (/\.(Commit)\(\)/.test(line)) {
      return { kind: 'write', label: 'saves the change', line: i };
    }
    return { kind: 'call', label: verbaliseGo(call), line: i };
  };

  let lastStep: WorkflowStep | undefined;
  for (let i = bodyStart + 1; i < sym.endLine; i++) {
    const m0 = masked[i];
    const l = orig[i];
    const t = m0.trim();
    if (pendingCondition && i > pendingEnd) {
      flushPending();
    }
    if (!t || t === '}' || t === '{' || /^(defer|var|const)\b/.test(t) || /^case\b|^default:/.test(t)) {
      continue;
    }

    // if err := doX(); err != nil {  — a call and its check on one line
    const inlineErr = /^if\s+(?:\w+\s*,\s*)?err\s*:?=\s*([\w.]+)\s*\((.*?);\s*err\s*!=\s*nil\s*\{/.exec(t);
    const errCheck = /^if\s+err\s*!=\s*nil\s*\{/.test(t) || !!inlineErr;
    if (errCheck) {
      if (inlineErr) {
        const s = describeCall(inlineErr[1], l, i);
        if (s) {
          push(s);
          lastStep = s;
        }
      }
      const end = blockEnd(masked, i, sym.endLine);
      const { outcome } = outcomeOf(orig, i + 1, end);
      if (lastStep && !/, or /.test(lastStep.label)) {
        lastStep.label = outcome === 'stops' ? `${lastStep.label}, or stops if that fails` : `${lastStep.label}, or ${outcome} if that fails`;
      } else {
        push({ kind: 'error', label: outcome === 'stops' ? 'stops if something failed' : `${outcome} if something failed`, line: i });
      }
      i = end;
      continue;
    }

    // if <cond> { … return } — an early exit; otherwise the condition colours the next step
    const cond = /^if\s+(.+?)\s*\{\s*$/.exec(t);
    if (cond) {
      const end = blockEnd(masked, i, sym.endLine);
      const inner = masked.slice(i + 1, end).join('\n');
      if (/\breturn\b/.test(inner)) {
        const { outcome } = outcomeOf(orig, i + 1, end);
        const msg = /(?:http\.Error|errors\.New|fmt\.Errorf|"error"\s*:)\s*\(?\s*\w*\s*,?\s*"([^"]{1,50})"/.exec(orig.slice(i + 1, end + 1).join(' '))?.[1];
        push({
          kind: outcome.startsWith('answers') || /err|Err/.test(inner) ? 'error' : 'branch',
          label: `${outcome === 'stops' ? 'stops early' : outcome} when ${humanGoCondition(cond[1])}${msg ? ` (“${shorten(msg, 36)}”)` : ''}`,
          line: i
        });
        i = end;
      } else {
        pendingCondition = humanGoCondition(cond[1]);
        pendingEnd = end;
        const change = /^\s*(\w+)(?:\.(\w+))?\s*([-+*/]?)=[^=]/m.exec(inner);
        pendingFallback = change
          ? `${change[3] === '-' || change[3] === '/' ? 'reduces' : change[3] ? 'increases' : 'sets'} ${pluralGo(change[2] ?? change[1])}`
          : undefined;
      }
      continue;
    }

    let m: RegExpExecArray | null;
    if ((m = /^for\s+(?:[\w, ]+:?=\s*)?range\s+([\w.()[\]]+)\s*\{/.exec(t))) {
      push({ kind: 'loop', label: `goes through each ${pluralGo(m[1].split('.').pop()!.replace(/\(\)$/, ''))}`, line: i });
      continue;
    }
    if (/^for\s*\{/.test(t)) {
      push({ kind: 'loop', label: 'repeats until stopped', line: i });
      continue;
    }
    if ((m = /^for\s+(.+?)\s*\{/.exec(t))) {
      push({ kind: 'loop', label: `repeats while ${shorten(m[1], 36)}`, line: i });
      continue;
    }
    if ((m = /^switch\s*(.*?)\s*\{/.exec(t))) {
      push({ kind: 'branch', label: m[1] ? `chooses by ${shorten(m[1].replace(/^\w+\s*:=\s*/, ''), 36)}` : 'chooses between cases', line: i });
      continue;
    }
    if ((m = /^go\s+(?:func\b|([\w.]+)\s*\()/.exec(t))) {
      push({ kind: 'call', label: `starts ${m[1] ? verbaliseGo(m[1]) : 'a background task'} in the background`, line: i });
      continue;
    }
    if (/^panic\(/.test(t)) {
      push({ kind: 'error', label: 'crashes (panic)', line: i });
      continue;
    }

    // Responses written without a return: c.JSON(200, x), c.Status(204), http.Error.
    const written = RESPONSE_RE.exec(t);
    if (written) {
      const code = status(written[2]);
      push({
        kind: code && code >= '400' ? 'error' : 'return',
        label: `answers ${code ?? ''}${written[3] && !/^gin\.H|^map/.test(written[3]) ? ` with ${pluralGo(written[3].split('.').pop()!)}` : ''}`.replace(/\s+/g, ' ').trim(),
        line: i
      });
      continue;
    }
    if (/http\.Error\(/.test(t)) {
      const { outcome } = outcomeOf(orig, i, i);
      push({ kind: 'error', label: outcome, line: i });
      continue;
    }

    if ((m = /^return\s*(.*)$/.exec(t))) {
      const value = m[1].trim();
      const origValue = /^\s*return\s*(.*)$/.exec(l)?.[1].trim() ?? value;
      const resp = /\.(JSON|String|XML|Status|NoContent|SendStatus|Redirect)\s*\(\s*([^,)]*)\s*,?\s*(\w*)/.exec(origValue);
      let label: string;
      let kind: WorkflowStep['kind'] = 'return';
      if (resp) {
        const code = status(resp[2]);
        label = `answers ${code ?? ''}${resp[3] ? ` with ${pluralGo(resp[3])}` : ''}`.replace(/\s+/g, ' ').trim();
        if (code && code >= '400') {
          kind = 'error';
        }
      } else if (!value) {
        label = 'finishes';
      } else if (/^(nil\s*,\s*)?err$|,\s*err$/.test(value)) {
        kind = 'error';
        label = 'passes the error on';
      } else if ((m = /(errors\.New|fmt\.Errorf)\(\s*"([^"]{1,60})/.exec(origValue))) {
        kind = 'error';
        label = `fails: ${shorten(m[2].replace(/%\w/g, '…'), 44)}`;
      } else if (/^nil$/.test(value)) {
        label = 'finishes without error';
      } else {
        const first = firstTopLevel(value).replace(/^&/, '');
        const called = /^([\w.]+)\s*\(.*\)$/.exec(first);
        label = called ? `returns the result of ${verbaliseGo(called[1])}` : /^[\w.]+$/.test(first) ? `returns ${pluralGo(first.split('.').pop()!)}` :
          /^\w+\{/.test(first) ? `returns a new ${pluralGo(first.split('{')[0])}` : `returns ${shorten(first, 36)}`;
      }
      push({ kind, label, line: i });
      continue;
    }

    // x = append(x, y)
    if ((m = /^(\w+)\s*=\s*append\(\s*\1\b/.exec(t))) {
      push({ kind: 'compute', label: `adds to ${pluralGo(m[1])}`, line: i });
      continue;
    }

    // x, err := call(...)   /   x := call(...)   /   call(...)
    const assign = /^(?:[\w, ]+?\s*:?=\s*)?&?([\w.]+)\s*\(/.exec(t);
    if (assign && !/^(if|for|switch|return|go|defer)\b/.test(t)) {
      const call = assign[1];
      if (!/^(append|make|len|new|cap|copy|delete|close|string|int|int64|float64|byte|rune)$/.test(call)) {
        const s = describeCall(call, l, i);
        if (s) {
          push(s);
          lastStep = s;
        }
      }
      continue;
    }

    // x.Field = value
    if ((m = /^(\w+)\.(\w+)\s*=\s*[^=]/.exec(t))) {
      push({ kind: 'compute', label: `sets ${pluralGo(m[2])}`, line: i });
    }
  }

  if (pendingCondition) {
    flushPending();
  }

  return {
    trigger,
    requires: [...requires],
    inputs,
    steps: dedupe(steps).slice(0, 14),
    confidence: 'heuristic'
  };
}
