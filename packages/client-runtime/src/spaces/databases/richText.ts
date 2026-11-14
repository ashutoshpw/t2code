import type { SpaceRichRun } from "@t2code/contracts/spaces";

import { canonicalJson } from "./queryKey.ts";

const sameStyle = (a: SpaceRichRun, b: SpaceRichRun) => {
  const { text: _a, ...left } = a;
  const { text: _b, ...right } = b;
  return canonicalJson(left) === canonicalJson(right);
};

/**
 * The runs of a cell after its text was edited as plain text. The old runs keep their marks in the
 * common prefix and suffix; the replaced middle takes the marks of the old run at the start of the
 * change (none when the change starts past the end), and neighbours with equal marks merge.
 */
export function retainMarks(
  runs: ReadonlyArray<SpaceRichRun>,
  nextText: string,
): ReadonlyArray<SpaceRichRun> {
  const old = runs.map((run) => run.text).join("");
  if (old === nextText) return runs;
  const limit = Math.min(old.length, nextText.length);
  let prefix = 0;
  while (prefix < limit && old[prefix] === nextText[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < limit - prefix &&
    old[old.length - 1 - suffix] === nextText[nextText.length - 1 - suffix]
  )
    suffix += 1;

  const out: SpaceRichRun[] = [];
  const push = (run: SpaceRichRun) => {
    if (run.text === "") return;
    const last = out.at(-1);
    if (last !== undefined && sameStyle(last, run))
      out[out.length - 1] = { ...last, text: last.text + run.text };
    else out.push(run);
  };
  const slice = (from: number, to: number) => {
    let offset = 0;
    for (const run of runs) {
      const start = Math.max(from, offset);
      const end = Math.min(to, offset + run.text.length);
      if (start < end) push({ ...run, text: run.text.slice(start - offset, end - offset) });
      offset += run.text.length;
    }
  };
  slice(0, prefix);
  let offset = 0;
  let at: SpaceRichRun | undefined;
  for (const run of runs) {
    if (prefix >= offset && prefix < offset + run.text.length) at = run;
    offset += run.text.length;
  }
  const middle = nextText.slice(prefix, nextText.length - suffix);
  push(at === undefined ? { text: middle, marks: [] } : { ...at, text: middle });
  slice(old.length - suffix, old.length);
  return out;
}
