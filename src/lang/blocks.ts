import { StepHeader, WorkflowStep } from '../types';

/**
 * Nesting for the step readers: which loops and conditions each step sits
 * inside, so the panel can draw bodies indented under their header and an
 * if/else as two paths.
 *
 * A condition only becomes a step of its own once something inside it does —
 * `if not rows: raise …` stays what it always was, a way out of the function,
 * rather than a header over a lone failure. Loops are headed as soon as they
 * open: "goes through each batch" is a step either way.
 */
export interface OpenBlock {
  id: number;
  kind: StepHeader['kind'];
  label: string;
  line: number;
  /** Python: the header's indent. A line at or left of it closes the block. */
  indent?: number;
  /** Go: the line of the closing brace. */
  end?: number;
  pairOf?: number;
  headed: boolean;
  /** Anything at all was pushed inside, headed or not. */
  emitted: boolean;
  /** Said instead when the block closes with nothing inside (`subtotal -= …`). */
  fallback?: WorkflowStep;
}

export class BlockTracker {
  private nextId = 1;
  private readonly stack: OpenBlock[] = [];
  private readonly all = new Map<number, OpenBlock>();
  /** The last condition to close, so an `else` straight after can pair with it. */
  lastClosed?: OpenBlock;

  constructor(private readonly steps: WorkflowStep[]) {}

  open(block: Omit<OpenBlock, 'id' | 'headed' | 'emitted'>, header?: WorkflowStep): OpenBlock {
    const b: OpenBlock = { ...block, id: this.nextId++, headed: false, emitted: false };
    this.all.set(b.id, b);
    this.stack.push(b);
    if (header) {
      // Loops head themselves: the step is pushed now, inside its parents only.
      this.stack.pop();
      this.push(header);
      this.stack.push(b);
      header.header = { id: b.id, kind: b.kind, pairOf: b.pairOf };
      b.headed = true;
    }
    return b;
  }

  /** Close every block the predicate says has ended, innermost first. */
  closeWhile(ended: (b: OpenBlock) => boolean): void {
    while (this.stack.length && ended(this.stack[this.stack.length - 1])) {
      const b = this.stack.pop()!;
      if (!b.emitted && b.fallback) {
        this.push({ ...b.fallback });
      }
      this.lastClosed = b;
    }
  }

  /**
   * Add a step at the current nesting. Ways out — failures, early stops — sit
   * at the level of the nearest headed block, so a lone `raise` under an `if`
   * stays a branch off the step before instead of conjuring a header.
   */
  push(step: WorkflowStep, exitLike = step.kind === 'error' || /^stops early\b/.test(step.label)): void {
    for (const b of this.stack) {
      b.emitted = true;
    }
    if (!exitLike) {
      this.stack.forEach((b, i) => {
        if (!b.headed) {
          b.headed = true;
          const paired = b.pairOf !== undefined ? this.all.get(b.pairOf) : undefined;
          this.steps.push({
            kind: 'branch',
            label: b.kind === 'else' && paired && !paired.headed ? `unless ${paired.label.replace(/^if /, '')}` : b.label,
            line: b.line,
            scope: this.stack.slice(0, i).filter((o) => o.headed).map((o) => o.id),
            header: { id: b.id, kind: b.kind, pairOf: paired?.headed ? b.pairOf : undefined }
          });
        }
      });
    }
    step.scope = this.stack.filter((b) => b.headed).map((b) => b.id);
    this.steps.push(step);
  }

}
