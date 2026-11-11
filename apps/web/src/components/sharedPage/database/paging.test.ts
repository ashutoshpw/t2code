import type { SpaceSharedDatabaseRowPage, SpaceSharedDatabaseWindow } from "@t2code/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { agendaSections, monthRange } from "./agenda";
import {
  appendBucket,
  appendRows,
  bucketId,
  continueOrRestart,
  fromWindow,
  MAX_WINDOW_RESTARTS,
  walkRowBody,
} from "./paging";
import { classifyFailure, type Fetched } from "./request";
import { row } from "./sharedDatabase.testkit";
import { orderBuckets } from "./viewModel";

const asWindow = (value: object) => value as SpaceSharedDatabaseWindow;
const win = (rows: ReadonlyArray<object>, extra: object = {}) =>
  asWindow({ rows, relatedPages: {}, options: {}, nextCursor: null, ...extra });
const ok = <A>(value: A): Fetched<A> => ({ ok: true, value });
const refused: Fetched<never> = { ok: false, problem: "unavailable" };

describe("window merging", () => {
  it("appends rows without duplicates and merges options and related pages", () => {
    const first = fromWindow(
      win([row("a", "A")], {
        nextCursor: "c1",
        options: { st: [{ id: "o1", name: "Todo", color: "gray" }] },
      }),
    );
    const next = appendRows(
      first,
      win([row("a", "A"), row("b", "B")], {
        options: {
          st: [
            { id: "o1", name: "Todo", color: "gray" },
            { id: "o2", name: "Done", color: "green" },
          ],
        },
        relatedPages: { r1: { title: "R", dataSourceId: "ds2" } },
      }),
    );
    expect(next.rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(next.options.st?.map((o) => o.id)).toEqual(["o1", "o2"]);
    expect(next.relatedPages).toHaveProperty("r1");
    expect(next.nextCursor).toBeNull();
  });

  it("continues one bucket and leaves the others and their counts alone", () => {
    const keyA = { kind: "option", optionId: "o1" };
    const keyB = { kind: "empty" };
    const data = fromWindow(
      win([], {
        groups: [
          { key: keyA, count: 12, rows: [row("a", "A")], nextCursor: "c" },
          { key: keyB, count: 1, rows: [row("z", "Z")], nextCursor: null },
        ],
      }),
    );
    const next = appendBucket(
      data,
      bucketId({ key: keyA } as never),
      win([row("a", "A"), row("b", "B")]),
    );
    expect(next.groups?.[0]).toMatchObject({ count: 12, nextCursor: null });
    expect(next.groups?.[0]?.rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(next.groups?.[1]).toBe(data.groups?.[1]);
  });

  it("orders buckets by the saved order and keeps server order for the rest", () => {
    const bucket = (kind: string) => ({ key: { kind }, count: 1, rows: [], nextCursor: null });
    const ordered = orderBuckets(
      [bucket("a"), bucket("b"), bucket("c")] as never,
      [{ kind: "c" }, { kind: "a" }] as never,
    );
    expect(ordered.map((b) => (b.key as { kind: string }).kind)).toEqual(["c", "a", "b"]);
  });
});

describe("restarting a refused cursor", () => {
  it("returns the continuation when it is accepted", async () => {
    const first = vi.fn();
    const result = await continueOrRestart(async () => ok("more"), first);
    expect(result).toEqual({ kind: "more", value: "more" });
    expect(first).not.toHaveBeenCalled();
  });

  it("restarts from the first window once, and only for a refused cursor", async () => {
    expect(
      await continueOrRestart(
        async () => refused,
        async () => ok("first"),
      ),
    ).toEqual({
      kind: "restarted",
      value: "first",
    });
    expect(
      await continueOrRestart(
        async () => refused,
        async () => refused,
      ),
    ).toEqual({
      kind: "failed",
      problem: "unavailable",
    });
    const offline: Fetched<string> = { ok: false, problem: "offline" };
    const first = vi.fn();
    expect(await continueOrRestart(async () => offline, first)).toEqual({
      kind: "failed",
      problem: "offline",
    });
    expect(first).not.toHaveBeenCalled();
  });

  it("restarts a row body walk at most three times", async () => {
    const asRowPage = (value: object) => value as SpaceSharedDatabaseRowPage;
    const page = (blockId: string, nextCursor?: string) =>
      asRowPage({
        window: { blocks: [{ id: blockId }] },
        ...(nextCursor === undefined ? {} : { nextCursor }),
      });
    const cursors: Array<string | undefined> = [];
    const stale = vi.fn(async (cursor: string | undefined) => {
      cursors.push(cursor);
      return cursor === undefined ? ok(page("b1", "c1")) : refused;
    });
    expect(await walkRowBody(stale)).toEqual({ ok: false, problem: "unavailable" });
    expect(cursors.filter((c) => c === undefined)).toHaveLength(MAX_WINDOW_RESTARTS + 1);

    const walked = await walkRowBody(async (cursor) =>
      cursor === undefined ? ok(page("b1", "c1")) : ok(page("b2")),
    );
    expect(walked.ok && walked.value.window.blocks.map((b) => b.id)).toEqual(["b1", "b2"]);
  });
});

describe("failures", () => {
  it("maps the server's refusals the way the page loader does", () => {
    const body = (reason: string) => ({ reason, message: "x" });
    expect(classifyFailure(403, body("inactive"))).toBe("ended");
    expect(classifyFailure(403, body("unavailable"))).toBe("unavailable");
    expect(classifyFailure(429, body("busy"))).toBe("offline");
    expect(classifyFailure(503, null)).toBe("offline");
    expect(classifyFailure(400, body("invalid"))).toBe("invalid");
    expect(classifyFailure(403, "junk")).toBe("invalid");
  });
});

describe("agenda", () => {
  it("covers the whole month and files an earlier start under the first day", () => {
    expect(monthRange("2026-02-14")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    const range = monthRange("2026-11-11");
    const rows = [
      row("late", "Late", { d: { start: "2026-11-20" } }),
      row("early", "Early", { d: { start: "2026-10-28", end: "2026-11-03" } }),
      row("none", "None", {}),
    ].map((r) => r as never);
    const sections = agendaSections(rows, "d", range, "UTC");
    expect(sections.map((s) => [s.day, s.rows.map((r) => r.id)])).toEqual([
      ["2026-11-01", ["early"]],
      ["2026-11-20", ["late"]],
    ]);
  });
});
