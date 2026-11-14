import type { SpaceDataSourceId, SpacePageId, SpacePropertyId } from "@t2code/contracts/spaces";
import { describe, expect, it } from "vite-plus/test";

import type { CellWriteBatch } from "./cellEdits.ts";
import { DatabaseWriter, WRITER_DEBOUNCE_MS, WRITER_MAX_WAIT_MS, type WriteAck } from "./writer.ts";

const ds = "ds" as SpaceDataSourceId;
const page = (id: string) => id as SpacePageId;
const prop = "p" as SpacePropertyId;

function setup(
  overrides: { updateRows?: (batch: CellWriteBatch) => Promise<{ dataRevision: number }> } = {},
) {
  const timers = new Map<number, { at: number; run: () => void }>();
  let now = 0;
  let nextTimer = 0;
  const sent: CellWriteBatch[] = [];
  const reports: unknown[] = [];
  let revision = 0;
  const writer = new DatabaseWriter({
    updateRows:
      overrides.updateRows ??
      (async (batch) => {
        sent.push(batch);
        return { dataRevision: ++revision };
      }),
    limits: () => ({ maxRowsPerMutation: 10, maxCellsPerMutation: 10 }),
    schedule: (run, delay) => {
      const id = nextTimer++;
      timers.set(id, { at: now + delay, run });
      return () => void timers.delete(id);
    },
    rejected: (error) => (error as { rejected?: boolean }).rejected === true,
    report: (error) => reports.push(error),
  });
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of Array.from(timers))
      if (timer.at <= now) {
        timers.delete(id);
        timer.run();
      }
  };
  return { writer, sent, reports, advance, timers };
}
const edit = (id: string, value: number | null) => ({
  dataSourceId: ds,
  pageId: page(id),
  propertyId: prop,
  value,
});

describe("DatabaseWriter", () => {
  it("sends two cells of one row edited in the same tick as one row of one batch", async () => {
    const { writer, sent } = setup();
    writer.editCell(edit("a", 1));
    writer.editCell({ ...edit("a", 2), propertyId: "q" as SpacePropertyId });
    await writer.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.rows).toEqual([{ pageId: "a", cells: { p: 1, q: 2 } }]);
  });

  it("debounces, caps the wait and sends one coalesced batch", async () => {
    const { writer, sent, advance } = setup();
    writer.editCell(edit("a", 1));
    advance(WRITER_DEBOUNCE_MS - 1);
    writer.editCell(edit("a", 2));
    advance(WRITER_DEBOUNCE_MS - 1);
    expect(sent).toHaveLength(0);
    advance(1);
    await writer.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.rows).toEqual([{ pageId: "a", cells: { p: 2 } }]);
    expect(writer.getSnapshot().pending).toEqual({});
  });

  it("flushes at the maximum wait while edits keep arriving", async () => {
    const { writer, sent, advance } = setup();
    for (let elapsed = 0; elapsed < WRITER_MAX_WAIT_MS; elapsed += 200) {
      writer.editCell(edit("a", elapsed));
      advance(200);
    }
    await writer.flush();
    expect(sent.length).toBeGreaterThanOrEqual(1);
  });

  it("keeps an edit made while a batch is in flight", async () => {
    const release: Array<() => void> = [];
    const { writer, advance } = setup({
      updateRows: () => new Promise((resolve) => release.push(() => resolve({ dataRevision: 1 }))),
    });
    writer.editCell(edit("a", 1));
    advance(WRITER_DEBOUNCE_MS);
    await Promise.resolve();
    writer.editCell(edit("a", 2));
    release[0]?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(Object.values(writer.getSnapshot().pending).map((entry) => entry.value)).toEqual([2]);
  });

  it("drops a rejected batch and reports it, keeps edits on a transport failure", async () => {
    let failure: unknown = { rejected: true };
    const { writer, reports } = setup({
      updateRows: async () => {
        throw failure;
      },
    });
    writer.editCell(edit("a", 1));
    await writer.flush();
    expect(writer.getSnapshot().pending).toEqual({});
    expect(reports).toHaveLength(1);
    failure = new Error("offline");
    writer.editCell(edit("a", 3));
    await writer.flush();
    expect(writer.getSnapshot()).toMatchObject({ failed: 1 });
    expect(Object.keys(writer.getSnapshot().pending)).toHaveLength(1);
    writer.discardFailed();
    expect(writer.getSnapshot()).toMatchObject({ failed: 0, pending: {} });
  });

  it("retries failed edits", async () => {
    let offline = true;
    const sent: number[] = [];
    const { writer } = setup({
      updateRows: async (batch) => {
        if (offline) throw new Error("offline");
        sent.push(batch.edits.length);
        return { dataRevision: 1 };
      },
    });
    writer.editCell(edit("a", 1));
    await writer.flush();
    offline = false;
    writer.retry();
    await writer.flush();
    expect(sent).toEqual([1]);
    expect(writer.getSnapshot().failed).toBe(0);
  });

  it("hands the edits to the ack listeners before they settle", async () => {
    const { writer } = setup();
    const seen: Array<{ edits: number; pending: number }> = [];
    writer.onAck((ack) =>
      seen.push({
        edits: ack.edits.length,
        pending: Object.keys(writer.getSnapshot().pending).length,
      }),
    );
    writer.editCell(edit("a", 1));
    await writer.flush();
    expect(seen).toEqual([{ edits: 1, pending: 1 }]);
    expect(writer.getSnapshot().pending).toEqual({});
  });

  it("stays busy until the ack listeners ran", async () => {
    const { writer } = setup();
    const seen: Array<{ busy: boolean; ack: WriteAck }> = [];
    writer.onAck((ack) => seen.push({ busy: writer.busy(ds), ack }));
    expect(writer.busy(ds)).toBe(false);
    await writer.track(ds, { propertyIds: [prop], structural: true }, async () => ({
      dataRevision: 7,
    }));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.busy).toBe(true);
    expect(seen[0]?.ack).toMatchObject({ dataRevision: 7, structural: true });
    expect(writer.busy(ds)).toBe(false);
    await expect(
      writer.track(ds, { structural: false }, async () => {
        throw new Error("x");
      }),
    ).rejects.toThrow("x");
    expect(writer.busy(ds)).toBe(false);
  });
});
