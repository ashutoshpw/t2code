import type {
  SpaceDatabaseQueryInput,
  SpaceDatabaseQueryResult,
  SpaceDatabaseRow,
} from "@t2code/contracts/spaces";
import { describe, expect, it } from "vite-plus/test";

import { DatabaseQuerySession, PENDING_MAX_FOLLOWS } from "./querySession.ts";

const tick = async () => {
  for (let turn = 0; turn < 8; turn++) await Promise.resolve();
};
const row = (id: string, title = id): SpaceDatabaseRow =>
  ({
    page: { id, title, revision: 1, createdAt: "t", updatedAt: "t" },
    number: 1,
    cells: { title },
  }) as unknown as SpaceDatabaseRow;
const input = (extra: Partial<SpaceDatabaseQueryInput> = {}) =>
  ({
    environmentId: "e",
    dataSourceId: "s",
    mode: "rows",
    limit: 2,
    timeZone: "UTC",
    ...extra,
  }) as unknown as SpaceDatabaseQueryInput;

function setup(options: { busy?: boolean; live?: boolean } = {}) {
  const calls: SpaceDatabaseQueryInput[] = [];
  const pending: Array<{
    input: SpaceDatabaseQueryInput;
    resolve: (result: Partial<SpaceDatabaseQueryResult>) => void;
    reject: (error: unknown) => void;
  }> = [];
  const timers = new Map<number, { delay: number; run: () => void }>();
  let nextTimer = 0;
  const session = new DatabaseQuerySession({
    query: (request: SpaceDatabaseQueryInput) => {
      calls.push(request);
      return new Promise((resolve, reject) =>
        pending.push({
          input: request,
          resolve: (result) =>
            resolve({
              dataSourceId: "s",
              schemaRevision: 1,
              dataRevision: 1,
              rows: [],
              relatedPages: {},
              nextCursor: null,
              ...result,
            } as SpaceDatabaseQueryResult),
          reject,
        }),
      );
    },
    schedule: (run: () => void, delay: number) => {
      const id = nextTimer++;
      timers.set(id, { delay, run });
      return () => void timers.delete(id);
    },
    busy: () => options.busy === true,
    live: () => options.live === true,
  } as never);
  const fire = () => {
    for (const [id, timer] of Array.from(timers)) {
      timers.delete(id);
      timer.run();
    }
  };
  const settle = async (result: Partial<SpaceDatabaseQueryResult>) => {
    pending.shift()?.resolve(result);
    await tick();
  };
  return { session, calls, pending, timers, fire, settle };
}

describe("DatabaseQuerySession", () => {
  it("asks for total and aggregates on the first window only", async () => {
    const { session, calls, settle } = setup();
    session.setInput(input());
    expect(calls[0]?.include).toEqual({ total: true, aggregates: true });
    await settle({ rows: [row("a"), row("b")], nextCursor: "c1" as never, total: 5 });
    expect(session.getSnapshot()).toMatchObject({ status: "ready", stale: false });
    session.loadMore();
    expect(calls[1]).toMatchObject({ cursor: "c1" });
    expect(calls[1]?.include).toBeUndefined();
    await settle({ rows: [row("c")], nextCursor: null });
    expect(session.getSnapshot().windows?.rows.map((entry) => entry.page.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    session.loadMore();
    expect(calls).toHaveLength(2);
  });

  it("keeps the old windows on a key change and drops answers of the old key", async () => {
    const { session, settle, pending } = setup();
    session.setInput(input());
    await settle({ rows: [row("a")] });
    session.setInput(input({ search: "x" }));
    expect(session.getSnapshot()).toMatchObject({ status: "loading", stale: true });
    expect(session.getSnapshot().windows?.rows).toHaveLength(1);
    session.setInput(input({ search: "xy" }));
    pending.shift()?.resolve({ rows: [row("old")] });
    await settle({ rows: [row("new")] });
    expect(session.getSnapshot().windows?.rows.map((entry) => entry.page.id)).toEqual(["new"]);
    expect(session.getSnapshot().stale).toBe(false);
  });

  it("does not refetch for an identical input", async () => {
    const { session, calls, settle } = setup();
    session.setInput(input());
    await settle({});
    session.setInput(input({ cursor: "ignored" as never }));
    expect(calls).toHaveLength(1);
  });

  it("ignores a counter bump while busy and refreshes otherwise", async () => {
    const busy = setup({ busy: true });
    busy.session.setInput(input());
    await busy.settle({});
    busy.session.invalidate();
    expect(busy.timers.size).toBe(0);
    const free = setup();
    free.session.setInput(input());
    await free.settle({});
    free.session.invalidate();
    expect(free.timers.size).toBe(1);
  });

  it("refreshes at most once a second under a stream of bumps", async () => {
    const { session, calls, timers, fire, settle } = setup({ live: true });
    session.setInput(input());
    await settle({ rows: [row("a")] });
    session.invalidate();
    expect([...timers.values()].map((timer) => timer.delay)).toEqual([150]);
    fire();
    await settle({ rows: [row("a")] });
    expect(calls).toHaveLength(2);
    for (let bump = 0; bump < 5; bump++) session.invalidate();
    // One cooldown timer and one coalesced refresh, which waits out the second.
    expect([...timers.values()].map((timer) => timer.delay)).toEqual([1000, 1000]);
    fire();
    await settle({ rows: [row("a")] });
    expect(calls).toHaveLength(3);
  });

  it("asks twice for pending values while the server pushes changes, then waits for an event", async () => {
    const { session, calls, timers, fire, settle } = setup({ live: true });
    session.setInput(input());
    await settle({ rows: [row("a")], computedPending: true });
    expect([...timers.values()].map((timer) => timer.delay)).toEqual([10_000]);
    fire();
    await settle({ rows: [row("a")], computedPending: true });
    expect([...timers.values()].map((timer) => timer.delay)).toEqual([30_000]);
    fire();
    await settle({ rows: [row("a")], computedPending: true });
    expect(timers.size).toBe(0);
    expect(calls).toHaveLength(3);
  });

  it("adopts the next revision silently and refreshes when the edit matters", async () => {
    const { session, timers, settle } = setup();
    session.setInput(input());
    await settle({ rows: [row("a")] });
    session.noteAck({ dataRevision: 2, affects: false, structural: false });
    expect(timers.size).toBe(0);
    expect(session.getSnapshot().windows?.dataRevision).toBe(2);
    session.noteAck({ dataRevision: 3, affects: true, structural: false });
    expect(timers.size).toBe(1);
  });

  it("keeps an acknowledged edit on the adopt path without another query", async () => {
    const { session, calls, timers, settle } = setup();
    session.setInput(input());
    await settle({ rows: [row("a", "old")] });
    const edit = { dataSourceId: "s", pageId: "a", propertyId: "title", value: "new", seq: 1 };
    session.noteAck({ dataRevision: 2, affects: false, structural: false, edits: [edit] as never });
    expect(session.getSnapshot().windows?.rows[0]?.cells["title" as never]).toBe("new");
    expect(timers.size).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("overlays an acknowledged edit that matters until a refresh answers with its revision", async () => {
    const { session, fire, settle } = setup();
    session.setInput(input());
    await settle({ rows: [row("a", "old")] });
    const edit = { dataSourceId: "s", pageId: "a", propertyId: "title", value: "new", seq: 1 };
    session.noteAck({ dataRevision: 2, affects: true, structural: false, edits: [edit] as never });
    expect(Object.values(session.getSnapshot().acked)).toHaveLength(1);
    fire();
    await settle({ rows: [row("a", "old")], dataRevision: 1 });
    // The answer predates the ack: keep the overlay and ask again.
    expect(Object.values(session.getSnapshot().acked)).toHaveLength(1);
    fire();
    await settle({ rows: [row("a", "new")], dataRevision: 2 });
    expect(Object.values(session.getSnapshot().acked)).toHaveLength(0);
  });

  it("refreshes when the first window predates an ack that arrived while loading", async () => {
    const { session, calls, fire, settle } = setup();
    session.setInput(input());
    session.noteAck({ dataRevision: 2, affects: false, structural: false });
    await settle({ rows: [row("a")], dataRevision: 1 });
    fire();
    expect(calls).toHaveLength(2);
  });

  it("re-grows buckets that held more rows before a groups refresh", async () => {
    const { session, calls, fire, settle } = setup();
    const bucket = (rows: string[], nextCursor: unknown) => ({
      key: "todo",
      count: 5,
      rows: rows.map((id) => row(id)),
      nextCursor,
    });
    session.setInput(input({ mode: "groups", rowsPerGroup: 2 }));
    await settle({ groups: [bucket(["a", "b"], "c1")] as never });
    session.loadBucket("todo" as never);
    await settle({ rows: [row("c"), row("d")], nextCursor: "c2" as never });
    expect(session.getSnapshot().windows?.groups?.[0]?.rows).toHaveLength(4);
    session.refresh();
    fire();
    await settle({ groups: [bucket(["a", "b"], "c1")] as never });
    expect(calls.at(-1)?.scope).toEqual({ group: "todo" });
    await settle({ rows: [row("c"), row("d")], nextCursor: "c2" as never });
    expect(session.getSnapshot().windows?.groups?.[0]?.rows).toHaveLength(4);
  });

  it("keeps a new card and a dropped card visible in a column that is only partly loaded", async () => {
    const { session, fire, settle } = setup();
    const bucket = (key: string, rows: string[], nextCursor: unknown) => ({
      key,
      count: 30,
      rows: rows.map((id) => row(id)),
      nextCursor,
    });
    session.setInput(input({ mode: "groups", rowsPerGroup: 25 }));
    const loaded = Array.from({ length: 25 }, (_, index) => `r${index}`);
    await settle({
      groups: [bucket("todo", loaded, "c1"), bucket("done", ["x"], null)] as never,
    });
    session.placeRow(row("new"), "todo" as never);
    session.setPlacement("x", { group: "todo" as never, beforeRowId: null });
    session.refresh();
    fire();
    await settle({
      groups: [bucket("todo", loaded, "c1"), bucket("done", [], null)] as never,
    });
    const placed = session.getSnapshot().placed;
    expect(placed.map((entry) => entry.row.page.id).sort()).toEqual(["new", "x"]);
    expect(placed.every((entry) => entry.counted === true && entry.group === '"todo"')).toBe(true);
    // The next refresh that does load the row drops its placed copy.
    session.refresh();
    fire();
    await settle({
      groups: [bucket("todo", [...loaded.slice(0, 23), "new", "x"], null)] as never,
    });
    expect(session.getSnapshot().placed).toEqual([]);
  });

  it("does not keep a card again once its row sits in another column or is trashed", async () => {
    const { session, fire, settle } = setup();
    const bucket = (key: string, rows: string[], nextCursor: unknown) => ({
      key,
      count: 30,
      rows: rows.map((id) => row(id)),
      nextCursor,
    });
    session.setInput(input({ mode: "groups", rowsPerGroup: 25 }));
    const loaded = Array.from({ length: 25 }, (_, index) => `r${index}`);
    const refresh = async (done: string[]) => {
      session.refresh();
      fire();
      await settle({
        groups: [bucket("todo", loaded, "c1"), bucket("done", done, "c2")] as never,
      });
    };
    await settle({ groups: [bucket("todo", loaded, "c1"), bucket("done", [], "c2")] as never });
    session.placeRow(row("moved"), "todo" as never);
    session.placeRow(row("gone"), "todo" as never);
    await refresh([]);
    expect(session.getSnapshot().placed).toHaveLength(2);
    session.forgetRow("gone");
    await refresh(["moved"]);
    expect(session.getSnapshot().placed).toEqual([]);
  });

  it("keeps a card dragged into another partly loaded column in the new column", async () => {
    const { session, fire, settle } = setup();
    const bucket = (key: string, rows: string[], nextCursor: unknown) => ({
      key,
      count: 40,
      rows: rows.map((id) => row(id)),
      nextCursor,
    });
    session.setInput(input({ mode: "groups", rowsPerGroup: 25 }));
    const ids = (prefix: string) => Array.from({ length: 25 }, (_, index) => `${prefix}${index}`);
    const buckets = () => ({
      groups: [bucket("todo", ids("t"), "c1"), bucket("done", ids("d"), "c2")] as never,
    });
    await settle(buckets());
    session.placeRow(row("new"), "todo" as never);
    session.refresh();
    fire();
    await settle(buckets());
    expect(session.getSnapshot().placed.map((entry) => entry.group)).toEqual(['"todo"']);
    session.setPlacement("new", { group: "done" as never, beforeRowId: null });
    session.refresh();
    fire();
    await settle(buckets());
    expect(
      session.getSnapshot().placed.map((entry) => [entry.row.page.id, entry.group, entry.counted]),
    ).toEqual([["new", '"done"', true]]);
  });

  it("drops a kept card on an acked edit of the group property, but never a flat placed row", async () => {
    const edit = (pageId: string, propertyId: string) =>
      ({ dataSourceId: "s", pageId, propertyId, value: "v", seq: 1 }) as never;
    const flat = setup();
    flat.session.setInput(input());
    await flat.settle({ rows: [row("a"), row("b")] });
    flat.session.placeRow(row("new"), null);
    flat.session.noteAck({
      dataRevision: 2,
      affects: true,
      structural: false,
      edits: [edit("new", "title")],
    });
    expect(flat.session.getSnapshot().placed.map((entry) => entry.row.page.id)).toEqual(["new"]);

    const { session, fire, settle } = setup();
    session.setInput(
      input({ mode: "groups", rowsPerGroup: 25, group: { property: "status" as never } }),
    );
    const rows = Array.from({ length: 25 }, (_, index) => row(`r${index}`));
    const groups = () => [{ key: "todo", count: 30, rows, nextCursor: "c1" }] as never;
    await settle({ groups: groups() });
    session.placeRow(row("new"), "todo" as never);
    session.refresh();
    fire();
    await settle({ groups: groups() });
    expect(session.getSnapshot().placed).toHaveLength(1);
    session.noteAck({
      dataRevision: 2,
      affects: true,
      structural: false,
      edits: [edit("new", "title")],
    });
    expect(session.getSnapshot().placed).toHaveLength(1);
    session.noteAck({
      dataRevision: 3,
      affects: true,
      structural: false,
      edits: [edit("new", "status")],
    });
    expect(session.getSnapshot().placed).toEqual([]);
  });

  it("refreshes from the top to the loaded depth, keeps row identity and clears placed rows", async () => {
    const { session, calls, fire, settle } = setup();
    session.setInput(input());
    await settle({ rows: [row("a"), row("b")], nextCursor: "c1" as never });
    session.loadMore();
    await settle({ rows: [row("c"), row("d")], nextCursor: "c2" as never });
    session.placeRow(row("n"), null);
    session.setPlacement("a", { group: { kind: "empty" }, beforeRowId: "c" });
    expect(Object.keys(session.getSnapshot().placements)).toEqual(["a"]);
    const before = session.getSnapshot().windows?.rows;
    session.refresh();
    fire();
    expect(calls.at(-1)?.cursor).toBeUndefined();
    await settle({ rows: [row("a"), row("b", "changed")], nextCursor: "c1" as never });
    await settle({ rows: [row("c"), row("d")], nextCursor: "c2" as never });
    const snapshot = session.getSnapshot();
    expect(snapshot.placed).toEqual([]);
    expect(snapshot.placements).toEqual({});
    expect(snapshot.windows?.rows[0]).toBe(before?.[0]);
    expect(snapshot.windows?.rows[1]).not.toBe(before?.[1]);
    expect(snapshot.windows?.rows[2]).toBe(before?.[2]);
    expect(calls).toHaveLength(4);
  });

  it("defers a refresh while held", async () => {
    const { session, timers, settle } = setup();
    session.setInput(input());
    await settle({});
    const release = session.hold();
    session.refresh();
    expect(timers.size).toBe(0);
    release();
    expect(timers.size).toBe(1);
  });

  it("drops a refresh answer that lands while held and runs it again on release", async () => {
    const { session, calls, fire, settle } = setup();
    session.setInput(input());
    await settle({ rows: [row("a")] });
    session.refresh();
    fire();
    const release = session.hold();
    session.setPlacement("a", { group: { kind: "empty" }, beforeRowId: null });
    await settle({ rows: [row("a", "changed")] });
    expect(Object.keys(session.getSnapshot().placements)).toEqual(["a"]);
    expect(session.getSnapshot().windows?.rows[0]?.page.title).toBe("a");
    release();
    fire();
    expect(calls).toHaveLength(3);
    await settle({ rows: [row("a", "changed")] });
    expect(session.getSnapshot().placements).toEqual({});
    expect(session.getSnapshot().windows?.rows[0]?.page.title).toBe("changed");
  });

  it("does not let a refresh that began before a placement clear it", async () => {
    const { session, fire, settle } = setup();
    session.setInput(input());
    await settle({ rows: [row("a")] });
    session.refresh();
    fire();
    session.setPlacement("a", { group: { kind: "empty" }, beforeRowId: null });
    await settle({ rows: [row("a")] });
    expect(Object.keys(session.getSnapshot().placements)).toEqual(["a"]);
  });

  it("keeps an acknowledged edit across a key change that keeps the windows", async () => {
    const { session, settle } = setup();
    session.setInput(input());
    await settle({ rows: [row("a", "old")] });
    const edit = { dataSourceId: "s", pageId: "a", propertyId: "title", value: "new", seq: 1 };
    session.noteAck({ dataRevision: 2, affects: true, structural: false, edits: [edit] as never });
    session.setInput(input({ search: "x" }));
    expect(Object.values(session.getSnapshot().acked)).toHaveLength(1);
  });

  it("does not let the first window clear a placement made while it was loading", async () => {
    const { session, settle } = setup();
    session.setInput(input());
    session.setPlacement("a", { group: { kind: "empty" }, beforeRowId: null });
    await settle({ rows: [row("a")] });
    expect(Object.keys(session.getSnapshot().placements)).toEqual(["a"]);
  });

  it("keeps following the cursor up to the fill cap and then stops", async () => {
    const { session, calls, settle } = setup();
    session.setInput(input(), { fillRows: 5 });
    await settle({ rows: [row("a"), row("b")], nextCursor: "c1" as never });
    await settle({ rows: [row("c"), row("d")], nextCursor: "c2" as never });
    await settle({ rows: [row("e"), row("f")], nextCursor: "c3" as never });
    expect(calls).toHaveLength(3);
    expect(session.getSnapshot().windows?.rows).toHaveLength(6);
    expect(session.getSnapshot().windows?.nextCursor).toBe("c3");
  });

  it("stops filling when the query is whole and when a window adds nothing", async () => {
    const { session, calls, settle } = setup();
    session.setInput(input(), { fillRows: 50 });
    await settle({ rows: [row("a")], nextCursor: "c1" as never });
    await settle({ rows: [row("b")], nextCursor: null });
    expect(calls).toHaveLength(2);
    session.setInput(input({ search: "x" }), { fillRows: 50 });
    await settle({ rows: [row("a")], nextCursor: "c1" as never });
    await settle({ rows: [], nextCursor: "c2" as never });
    expect(calls).toHaveLength(4);
  });

  it("restarts for another extra filter and keeps the include flags of the caller", async () => {
    const { session, calls, settle } = setup();
    const filter = (day: string) => ({ property: "d", operator: "on_or_after", value: day });
    session.setInput(input({ extraFilter: filter("2026-03-01") as never }));
    await settle({ rows: [row("a")] });
    session.setInput(input({ extraFilter: filter("2026-04-01") as never }));
    expect(session.getSnapshot().stale).toBe(true);
    expect(calls[1]?.extraFilter).toEqual(filter("2026-04-01"));
    await settle({ rows: [row("b")] });
    expect(session.getSnapshot().stale).toBe(false);
  });

  it("keeps the bucket scope on the first window and on a refresh", async () => {
    const { session, calls, fire, settle } = setup();
    const group = { kind: "option", optionId: "o" } as never;
    session.setInput(input({ mode: "rows", scope: { group } }));
    await settle({ rows: [row("a")] });
    expect(calls[0]?.scope).toEqual({ group });
    session.refresh();
    fire();
    expect(calls.at(-1)?.scope).toEqual({ group });
  });

  it("continues a bucket in rows mode and refreshes once on a stale cursor", async () => {
    const { session, calls, fire, settle, pending } = setup();
    const group = { kind: "option", optionId: "o" } as never;
    session.setInput(input({ mode: "groups", rowsPerGroup: 1 }));
    await settle({
      groups: [{ key: group, count: 3, rows: [row("a")], nextCursor: null }],
    });
    session.loadBucket(group);
    expect(session.getSnapshot().loadingBuckets.size).toBe(1);
    expect(calls[1]).toMatchObject({ mode: "rows", scope: { group } });
    await settle({ rows: [row("a"), row("b"), row("c")], nextCursor: null });
    expect(session.getSnapshot().windows?.groups?.[0]?.rows).toHaveLength(3);
    expect(session.getSnapshot().loadingBuckets.size).toBe(0);

    session.loadBucket(group);
    pending.shift()?.reject({ _tag: "SpaceCursorStaleError" });
    await tick();
    fire();
    await settle({ groups: [{ key: group, count: 3, rows: [row("a")], nextCursor: null }] });
    expect(session.getSnapshot().status).toBe("ready");
    session.loadBucket(group);
    pending.shift()?.reject({ _tag: "SpaceCursorStaleError" });
    await tick();
    expect(session.getSnapshot().status).toBe("ready");
  });

  it("turns a failed first window into an error and ignores late responses after dispose", async () => {
    const { session, pending, settle } = setup();
    session.setInput(input());
    pending.shift()?.reject(new Error("boom"));
    await tick();
    expect(session.getSnapshot().status).toBe("error");
    session.setInput(input({ search: "z" }));
    session.dispose();
    await settle({ rows: [row("a")] });
    expect(session.getSnapshot().status).toBe("loading");
  });

  it("keeps the windows when a continuation or refresh fails and retries it", async () => {
    const { session, calls, pending, settle, fire } = setup();
    session.setInput(input());
    await settle({ rows: [row("a"), row("b")], nextCursor: "c1" as never });
    session.loadMore();
    pending.shift()?.reject(new Error("socket"));
    await tick();
    expect(session.getSnapshot()).toMatchObject({ status: "ready", loadingMore: false });
    expect(session.getSnapshot().loadError).toBeInstanceOf(Error);
    expect(session.getSnapshot().windows?.rows).toHaveLength(2);
    session.retryLoad();
    expect(calls[2]).toMatchObject({ cursor: "c1" });
    expect(session.getSnapshot().loadError).toBeUndefined();
    await settle({ rows: [row("c")], nextCursor: null });
    expect(session.getSnapshot().windows?.rows).toHaveLength(3);

    session.refresh();
    fire();
    pending.shift()?.reject(new Error("socket"));
    await tick();
    expect(session.getSnapshot()).toMatchObject({ status: "ready", stale: false });
    expect(session.getSnapshot().loadError).toBeInstanceOf(Error);
    session.retryLoad();
    fire();
    await settle({ rows: [row("a"), row("b")], nextCursor: null });
    expect(session.getSnapshot().loadError).toBeUndefined();
  });

  it("merges related pages the UI just picked", async () => {
    const { session, settle } = setup();
    session.setInput(input());
    await settle({ rows: [row("a")] });
    session.noteRelatedPages({ r1: { id: "r1", title: "Task" } as never });
    expect(session.getSnapshot().relatedPages["r1"]?.title).toBe("Task");
  });

  it("asks again with a growing delay while computed values are pending, and stops when done", async () => {
    const { session, calls, timers, fire, settle } = setup();
    session.setInput(input());
    await settle({ rows: [row("a")], computedPending: true });
    expect(session.getSnapshot().computedPending).toBe(true);
    const delays: number[] = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      delays.push([...timers.values()][0]?.delay ?? -1);
      const before = calls.length;
      fire();
      expect(calls.length).toBe(before + 1);
      await settle({ rows: [row("a")], computedPending: true });
    }
    expect(delays).toEqual([400, 800, 1600, 3200, 5000, 5000]);
    fire();
    await settle({ rows: [row("a", "done")], computedPending: false });
    expect(session.getSnapshot().computedPending).toBe(false);
    expect(timers.size).toBe(0);
  });

  it("does not follow up on a changed input, and starts the backoff over on a user refresh", async () => {
    const { session, timers, fire, settle } = setup();
    session.setInput(input());
    await settle({ rows: [row("a")], computedPending: true });
    fire();
    await settle({ rows: [row("a")], computedPending: true });
    expect([...timers.values()][0]?.delay).toBe(800);
    session.setInput(input({ search: "x" }));
    expect(timers.size).toBe(0);
  });

  it("stops following pending values after the cap, and a user refresh starts it over", async () => {
    const { session, calls, timers, fire, settle } = setup();
    session.setInput(input());
    await settle({ rows: [row("a")], computedPending: true });
    for (let attempt = 0; attempt < PENDING_MAX_FOLLOWS; attempt++) {
      expect(timers.size).toBe(1);
      fire();
      await settle({ rows: [row("a")], computedPending: true });
    }
    expect(timers.size).toBe(0);
    expect(calls.length).toBe(PENDING_MAX_FOLLOWS + 1);
    session.refresh();
    fire();
    await settle({ rows: [row("a")], computedPending: true });
    expect([...timers.values()][0]?.delay).toBe(400);
  });
});
