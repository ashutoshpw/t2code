import { describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const harness = createOxlintRuleHarness("t2code/no-throw-in-effect-generator");

describe("t2code/no-throw-in-effect-generator", () => {
  harness.invalid(
    "reports throw in Effect.gen",
    `const program = Effect.gen(function* () {
  if (Math.random() > 1) throw new Error("boom");
  return 1;
});`,
  );

  harness.invalid(
    "reports throw in Effect.fn and Effect.fnUntraced bodies",
    `export const a = Effect.fn("A.run")(function* (input: number) {
  if (input < 0) throw new RangeError("negative");
});
export const b = Effect.fnUntraced(function* () {
  try {
    yield* Effect.void;
  } catch (cause) {
    throw cause;
  }
});`,
  );

  harness.valid(
    "allows throw in plain functions and callbacks nested in a generator",
    `export function parse(input: string) {
  if (input === "") throw new Error("empty");
  return input;
}
const program = Effect.gen(function* () {
  return yield* Effect.try({
    try: () => {
      throw new Error("sync boundary");
    },
    catch: (cause) => cause,
  });
});`,
  );

  harness.valid(
    "allows typed failures in generators",
    `const program = Effect.gen(function* () {
  return yield* Effect.fail(new Error("typed"));
});`,
  );
});
