import type { FormulaValue } from "./values.ts";

export interface EvalContext {
  /** Epoch ms; only now() and today() read it. */
  readonly now: number;
  /** IANA zone. */
  readonly timeZone: string;
  readonly row: { readonly id: string; readonly dataSourceId: string };
  /** Synchronous; the caller preloads. An unknown page or property returns null. */
  read(
    page: { readonly id: string; readonly dataSourceId: string },
    propertyId: string,
  ): FormulaValue;
  titleOf(pageId: string): string | undefined;
  readonly maxSteps?: number;
  /** Adds the steps each evaluation spent, so a caller can bound the work of a whole batch. */
  readonly meter?: { steps: number };
}

const DEFAULT_MAX_STEPS = 20_000;

/** Thrown when the step budget is spent; caught at the top of `evaluate`. */
const BUDGET_EXCEEDED = Object.freeze({ budgetExceeded: true });

export interface Runtime {
  readonly ctx: EvalContext;
  /** Normalized time zone. */
  readonly tz: string;
  tick(steps?: number): void;
  /** Steps spent so far. */
  spent(): number;
  /** Regex VM instructions; 64 of them cost one step. */
  work(instructions: number): void;
}

export function createRuntime(ctx: EvalContext, tz: string): Runtime {
  const max = ctx.maxSteps ?? DEFAULT_MAX_STEPS;
  let steps = 0;
  let pending = 0;
  const tick = (n = 1): void => {
    steps += n;
    if (steps > max) throw BUDGET_EXCEEDED;
  };
  return {
    ctx,
    tz,
    tick,
    spent: () => steps,
    work(instructions) {
      pending += instructions;
      if (pending >= 64) {
        const whole = Math.floor(pending / 64);
        pending -= whole * 64;
        tick(whole);
      }
    },
  };
}
