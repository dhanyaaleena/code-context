/**
 * The shape the Context API is meant to return. The spike fills it from local
 * analysis instead of a backend, but nothing else in the extension knows that —
 * swapping in a real HTTP client means replacing buildContext() only.
 */

export type Confidence = 'resolved' | 'heuristic' | 'unresolved' | 'external';

export interface SymbolRef {
  name: string;
  qualified: string;
  file: string;          // workspace-relative
  line: number;          // 0-based
  confidence: Confidence;
  reason?: string;       // why we think this edge exists
  /** A call site invokes it; a reference passes it around (Depends, decorators, registries). */
  kind?: 'call' | 'reference';
}

export interface HistoryEvent {
  sha: string;
  author: string;
  date: string;          // ISO
  subject: string;
  /** The message body, trailers stripped — usually where the reason lives. */
  body?: string;
  /** True for the commit that introduced the symbol: the statement of intent. */
  origin?: boolean;
  pr?: string;           // parsed from the subject, e.g. "391"
  aiAssisted: boolean;
}

export type EntryKind = 'http' | 'task' | 'schedule' | 'cli' | 'event' | 'signal';

/** A way the outside world gets in: a URL, a job, a command, an event. */
export interface EntryPoint {
  kind: EntryKind;
  /** Human-facing handle, e.g. "GET /admin/stats" or "background job: reindex". */
  label: string;
  framework: string;
  detail?: string;
  symbol: SymbolRef;
}

export interface FeatureContext {
  /** Short, human name for the area — the last meaningful path segment. */
  name: string;
  /** Full directory the feature was derived from. */
  path: string;
  /** Service or app this sits in, when the repo is a monorepo. */
  service?: string;
  modules: number;
  symbols: number;
  /** Where this symbol sits inside its feature. */
  role: 'entry point' | 'core' | 'leaf' | 'shared utility';
  /** Roots of the caller tree: what ultimately reaches this code. */
  entryPoints: SymbolRef[];
  /** Package-level import edges, the zoomed-out sibling of the call graph. */
  dependsOn: string[];
  dependedOnBy: string[];
  /** Files that keep changing in the same commits — a feature signal from Git. */
  coChange: { file: string; commits: number }[];
}

export type StepKind = 'guard' | 'read' | 'write' | 'call' | 'error' | 'return' | 'compute' | 'filter' | 'branch' | 'loop';

export interface WorkflowStep {
  kind: StepKind;
  label: string;
  detail?: string;
  line: number;
  /** Exception types folded into one handler step, so a run can keep merging. */
  caught?: string[];
}

export interface WorkflowInput {
  name: string;
  type?: string;
  source: 'path' | 'query' | 'body' | 'dependency';
}

/** What the code does, in order — the shape a call graph cannot express. */
export interface Workflow {
  trigger?: string;
  requires: string[];
  inputs: WorkflowInput[];
  steps: WorkflowStep[];
  confidence: 'heuristic';
}

export interface ContextResponse {
  /** One plain sentence, computed. The thing to read before anything else. */
  summary: string;
  /** How the outside world reaches this code, in product terms rather than call terms. */
  reachedFrom: EntryPoint[];
  /** Set when the symbol is itself an entry point. */
  isEntryPoint?: EntryPoint;
  /** Ordered reading of the body: guards, reads, writes, outcomes. */
  workflow: Workflow;
  symbol: {
    name: string;
    qualified: string;
    file: string;
    startLine: number;
    endLine: number;
  };
  purpose: {
    text: string;
    type: 'ai_summary' | 'stub';
    evidence: string[];
  };
  feature: FeatureContext;
  callers: SymbolRef[];
  callees: SymbolRef[];
  history: HistoryEvent[];
  historySource: 'symbol' | 'file' | 'none';
  /** Changes older than the window, dropped from `history` but counted. */
  historyOlder: number;
  tests: { count: number; files: string[] };
  impact: { direct: number; transitive: number };
  indexedAt: string;     // commit sha or "working tree"
  dirty: boolean;        // is the buffer ahead of the index?
}

/** Result of the single AI call. Always optional — the panel works without it. */
export type Narration =
  | { state: 'error'; reason: string; cached?: boolean }
  | {
      state: 'ready';
      featureName: string;
      headline: string;
      flow: string;
      risk: string;
      /** One plain line per computed workflow step, same order. Empty if unusable. */
      steps: string[];
      /** What it needs and is given, in plain words. */
      needs: string;
      /** Why this was built in the first place — the need it answered. */
      origin: string;
      /** Whether that reason is read from the commits or inferred around them. */
      originBasis: 'stated' | 'inferred';
      /** How the reason has changed since, if it has. */
      history: string;
      /** Concrete, evidence-backed cautions. At most three. */
      watchOut: string[];
      confidence: 'high' | 'medium' | 'low';
      evidence: string[];
      evidenceHash?: string;
      model?: string;
      cached?: boolean;
      usage?: { input: number; output: number };
    };
