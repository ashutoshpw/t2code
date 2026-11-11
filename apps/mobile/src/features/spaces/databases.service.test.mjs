import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Cause from "effect/Cause";
import * as Stream from "effect/Stream";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import {
  EnvironmentId,
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  WS_METHODS,
} from "../../../../../packages/contracts/src/index.ts";
import { SpaceBlockId } from "../../../../../packages/contracts/src/spaces.ts";
import { createSpacesEnvironmentAtoms } from "../../../../../packages/client-runtime/src/state/spaces.ts";
import { executeAtomQuery } from "../../../../../packages/client-runtime/src/state/runtime.ts";
import { createDatabaseMutations } from "../../../../../packages/client-runtime/src/state/spacesDatabaseMutations.ts";
import { createEnvironmentSessionAtoms } from "../../../../../packages/client-runtime/src/state/session.ts";
import { EnvironmentRegistry } from "../../../../../packages/client-runtime/src/connection/registry.ts";
import { EnvironmentSupervisor } from "../../../../../packages/client-runtime/src/connection/supervisor.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
} from "../../../../../packages/client-runtime/src/connection/model.ts";
import {
  DatabaseQuerySession,
  SpaceDocumentSession,
  createSpaceServiceSessionAdapter,
  deriveViewRows,
  EMPTY_PENDING_CELL_EDITS,
  isSpaceDatabaseBlock,
  patchRowCells,
  recordAck,
  resolveBlockViews,
} from "../../../../../packages/client-runtime/src/spaces/index.ts";
import { addRow } from "./databases/addRow.ts";
import { editorFor, commitValue } from "./databases/cellEdit.ts";
import { createCellWriter, createWriteFailures } from "../../state/spacesDatabaseWriter.ts";
import { MobileSpaceEditing } from "./editing.ts";
import { diskDatabase } from "../../persistence/mobile-database.test-support.ts";
import { agendaSections } from "./databases/agenda.ts";
import { cardLines } from "./databases/cellText.ts";
import { formQueryInput, listItems, viewForm } from "./databases/viewForms.ts";
import { mobileSpacesServiceLayer, promiseRunner } from "./spacesMobile.test-support.mjs";
import * as SpacesService from "../../../../server/src/spaces/SpacesService.ts";

// The grant atoms are the only fake: every other layer is the real client runtime over the real service.
vi.mock("../../../../../packages/client-runtime/src/state/session.ts", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const sessions = Atom.family(() => Atom.make(AsyncResult.initial()));
  return { createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }) };
});

const ZONE = "UTC";
const noHint = () => undefined;
const run = (text) => [{ text, marks: [] }];

const fixture = Effect.fn("MobileDatabasesTest.fixture")(function* (use) {
  const disk = yield* diskDatabase();
  const environmentId = EnvironmentId.make("databases-environment");
  yield* Effect.gen(function* () {
    const service = yield* SpacesService.SpacesService;
    const runner = yield* promiseRunner();
    const capability = yield* service.getCapability(environmentId);
    const state = yield* SubscriptionRef.make({
      ...AVAILABLE_CONNECTION_STATE,
      phase: "connected",
      generation: 1,
      attempt: 1,
    });
    const calls = [];
    const call = (tag, input, work) =>
      Effect.tryPromise({
        try: () => {
          calls.push({ tag, input });
          return runner(work(input));
        },
        catch: (error) => error,
      });
    const rpc = {
      client: {
        [WS_METHODS.spacesDatabasesList]: (input) =>
          call("list", input, (value) => service.listDatabases(value)),
        [WS_METHODS.spacesDatabasesGet]: (input) =>
          call("get", input, (value) => service.getDatabase(value)),
        [WS_METHODS.spacesDatabasesQuery]: (input) =>
          call("query", input, (value) => service.queryDatabase(value)),
        [WS_METHODS.spacesDatabasesRowsGet]: (input) =>
          call("row", input, (value) => service.getDatabaseRows(value)),
        [WS_METHODS.spacesDatabasesRowsUpdate]: (input) =>
          call("rowsUpdate", input, (value) => service.updateRows(value)),
        [WS_METHODS.spacesDatabasesRowsCreate]: (input) =>
          call("rowsCreate", input, (value) => service.createRows(value)),
        [WS_METHODS.spacesPagesGet]: (input) =>
          call("page", input, (value) => service.getPage(value)),
      },
    };
    const session = yield* SubscriptionRef.make(Option.some(rpc));
    const supervisor = {
      target: new PrimaryConnectionTarget({
        environmentId,
        label: "Databases test",
        httpBaseUrl: "https://databases.invalid",
        wsBaseUrl: "wss://databases.invalid",
      }),
      state,
      session,
    };
    const runtime = Atom.runtime(
      Layer.succeed(EnvironmentRegistry, {
        run: (_id, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisor),
        followStream: (_id, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor, supervisor),
        stateChanges: () => SubscriptionRef.changes(state),
      }),
    );
    const registry = AtomRegistry.make();
    yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
    const cap = Atom.make(capability);
    registry.mount(cap);
    const atoms = createSpacesEnvironmentAtoms(runtime, { capabilityAtom: () => cap });
    const grant = createEnvironmentSessionAtoms(runtime).sessionStateAtom(environmentId);
    registry.mount(grant);
    const permissions = (allowed, operate = false) => {
      const granted = allowed
        ? operate
          ? [AuthOrchestrationReadScope, AuthOrchestrationOperateScope]
          : [AuthOrchestrationReadScope]
        : [];
      registry.set(
        grant,
        AsyncResult.success({ authenticated: true, scopes: granted, permissions: granted }),
      );
    };
    permissions(true);
    registry.mount(atoms.changed(environmentId));
    const databases = atoms.databases;
    const db = yield* disk.open();
    const read = async (atom) => {
      const result = await executeAtomQuery(registry, atom, {
        refresh: true,
        reportFailure: false,
      });
      if (result._tag === "Failure") throw Cause.squash(result.cause);
      return result.value;
    };
    // The same port the app gives its sessions, with the timers left to the test.
    const timers = new Set();
    const viewSession = () =>
      new DatabaseQuerySession({
        query: (input) => read(databases.query({ environmentId, input })),
        schedule: (task) => {
          timers.add(task);
          return () => timers.delete(task);
        },
        busy: () => false,
      });
    const settled = (session, done) =>
      new Promise((resolve) => {
        let stop = () => {};
        const check = () => {
          const snapshot = session.getSnapshot();
          if (done(snapshot)) {
            stop();
            resolve(snapshot);
          }
        };
        stop = session.subscribe(check);
        check();
      });
    const mutations = createDatabaseMutations(databases, {
      newMutationId: () => globalThis.crypto.randomUUID(),
      // The service runs on the test clock, so its admission is dated from epoch zero.
      now: () => 0,
    });
    const failures = createWriteFailures();
    const writer = createCellWriter({
      environmentId,
      mutations,
      registry,
      canWrite: () => true,
      limits: () => undefined,
      schedule: (task) => {
        timers.add(task);
        return () => timers.delete(task);
      },
      failures,
    });
    const admission = yield* service.listSpaces({ environmentId });
    const common = { environmentId, receiptEpoch: admission.mutationAdmission.epoch };
    let mutation = 0;
    const next = (label) => `${label}-${++mutation}`;
    yield* use({
      service,
      run: runner,
      environmentId,
      capability,
      calls,
      registry,
      databases,
      atoms,
      read,
      permissions,
      viewSession,
      mutations,
      failures,
      writer,
      settled,
      timers,
      store: db.store,
      common,
      spaceId: admission.defaultSpaceId,
      next,
    });
  }).pipe(Effect.provide(mobileSpacesServiceLayer(disk.file, environmentId)));
}, Effect.scoped);

const ids = {
  points: "points",
  prio: "prio01",
  note: "note01",
  due: "due001",
  calc: "calc01",
  done: "done01",
};
const options = {
  low: { id: "low01", name: "Low", color: "blue" },
  high: { id: "high1", name: "High", color: "red" },
};

/** Host page with a database of 30 tasks: Points 1..30, alternating priority, five with a due date. */
const seed = async (c) => {
  const host = await c.run(
    c.service.createPage({
      ...c.common,
      mutationId: c.next("page"),
      spaceId: c.spaceId,
      baseRootOrderRevision: 0,
      title: "Host",
    }),
  );
  const created = await c.run(
    c.service.createDatabase({
      ...c.common,
      mutationId: c.next("database"),
      spaceId: c.spaceId,
      title: "Tasks",
      appendToPageId: host.page.id,
      properties: [
        { id: ids.points, name: "Points", type: "number", config: { format: "number" } },
        {
          id: ids.prio,
          name: "Priority",
          type: "select",
          options: [options.low, options.high],
        },
        { id: ids.note, name: "Secret note", type: "text" },
        { id: ids.due, name: "Due", type: "date" },
        { id: ids.done, name: "Done", type: "checkbox" },
        {
          id: ids.calc,
          name: "Double",
          type: "formula",
          config: { expression: 'prop("Points") * 2' },
        },
      ],
    }),
  );
  const dates = [
    { start: "2026-10-31" },
    { start: "2026-11-05" },
    { start: "2026-10-28", end: "2026-11-02" },
    { start: "2026-11-30" },
    { start: "2026-12-01" },
  ];
  const rows = Array.from({ length: 30 }, (_, index) => ({
    title: `Task ${index + 1}`,
    cells: {
      [ids.points]: index + 1,
      [ids.prio]: index % 2 === 0 ? options.low.id : options.high.id,
      [ids.note]: run(`note ${index + 1}`),
      [ids.done]: index % 3 === 0,
      ...(index < dates.length ? { [ids.due]: dates[index] } : {}),
    },
  }));
  const added = await c.run(
    c.service.createRows({
      ...c.common,
      mutationId: c.next("rows"),
      dataSourceId: created.dataSourceId,
      rows,
    }),
  );
  await c.run(c.service.drainComputed);
  const view = async (input) => {
    const made = await c.run(
      c.service.createView({
        ...c.common,
        mutationId: c.next("view"),
        dataSourceId: created.dataSourceId,
        ...input,
      }),
    );
    return made.viewId;
  };
  return { host: host.page, created, rowIds: added.rows.map((entry) => entry.pageId), view };
};

const databaseOf = async (c, databaseId) =>
  c.read(
    c.databases.database({
      environmentId: c.environmentId,
      input: { environmentId: c.environmentId, databaseId },
    }),
  );

const form = async (c, seeded, viewId) => {
  const model = await databaseOf(c, seeded.created.databaseId);
  const saved = model.views.find((entry) => entry.id === viewId);
  const dataSource = model.dataSources[0];
  const limits = c.capability.limits.databases;
  return { model, saved, dataSource, form: viewForm(saved, dataSource, limits) };
};

it.effect(
  "reads databases through the real client runtime and refuses without the read grant",
  () =>
    fixture((c) =>
      Effect.promise(async () => {
        const seeded = await seed(c);
        expect(c.capability.features?.databases).toBe(true);
        const listed = await c.read(
          c.databases.list({
            environmentId: c.environmentId,
            input: { environmentId: c.environmentId, spaceId: c.spaceId },
          }),
        );
        expect(listed.items.map((item) => item.database.id)).toContain(seeded.created.databaseId);
        const model = await databaseOf(c, seeded.created.databaseId);
        expect(model.database).toMatchObject({ title: "Tasks", live: true });
        expect(model.database.home.pageId).toBe(seeded.host.id);
        c.permissions(false);
        await expect(databaseOf(c, seeded.created.databaseId)).rejects.toMatchObject({
          _tag: "EnvironmentAuthorizationError",
        });
        await expect(
          c.read(
            c.databases.query({
              environmentId: c.environmentId,
              input: {
                environmentId: c.environmentId,
                dataSourceId: seeded.created.dataSourceId,
                mode: "rows",
                timeZone: ZONE,
              },
            }),
          ),
        ).rejects.toMatchObject({ _tag: "EnvironmentAuthorizationError" });
      }),
    ),
);

it.effect("applies a saved filtered and sorted view in windows and loads more on demand", () =>
  fixture((c) =>
    Effect.promise(async () => {
      const seeded = await seed(c);
      const viewId = await seeded.view({
        name: "Open",
        type: "table",
        filter: { property: ids.points, operator: "greater_than", value: 5 },
        sorts: [{ property: ids.points, direction: "descending" }],
        properties: [
          { propertyId: ids.points, visible: true },
          { propertyId: ids.prio, visible: true },
          { propertyId: ids.calc, visible: true },
        ],
        layout: { loadLimit: 10 },
      });
      const shown = await form(c, seeded, viewId);
      expect(shown.form).toMatchObject({ kind: "cards", mode: "rows", limit: 10 });
      const input = formQueryInput(shown.form, shown.saved, {
        environmentId: c.environmentId,
        timeZone: ZONE,
      });
      // Only what the cards draw is asked for: not the hidden note, due date or checkbox.
      expect(input.properties).toEqual([ids.calc, ids.points, ids.prio, "title"].sort());
      const session = c.viewSession();
      session.setInput(input);
      const first = await c.settled(session, (snapshot) => snapshot.status === "ready");
      expect(first.windows.rows.map((row) => row.cells.title)).toEqual(
        Array.from({ length: 10 }, (_, index) => `Task ${30 - index}`),
      );
      expect(first.windows.total).toBe(25);
      expect(JSON.stringify(first.windows.rows)).not.toContain("Secret");
      for (const row of first.windows.rows) expect(Object.keys(row.cells)).not.toContain(ids.note);
      session.loadMore();
      await c.settled(session, (snapshot) => snapshot.windows.rows.length === 20);
      session.loadMore();
      const third = await c.settled(session, (snapshot) => snapshot.windows.rows.length === 25);
      expect(third.windows.nextCursor).toBeNull();
      const titles = third.windows.rows.map((row) => row.cells.title);
      expect(new Set(titles).size).toBe(25);
      expect(titles.at(-1)).toBe("Task 6");
      const queries = c.calls.filter((entry) => entry.tag === "query");
      expect(queries.every((entry) => entry.input.limit === 10)).toBe(true);

      // The computed value arrives from the wire and is only displayed.
      const derived = deriveViewRows({
        mode: "rows",
        dataSourceId: seeded.created.dataSourceId,
        snapshot: third,
        writerPending: EMPTY_PENDING_CELL_EDITS,
      });
      const lines = cardLines(derived.rows[0], shown.form.columns, {
        relatedPages: third.relatedPages,
        optionHint: noHint,
        timeZone: ZONE,
      });
      expect(lines.map((line) => [line.name, line.text])).toEqual([
        ["Points", "30"],
        ["Priority", "High"],
        ["Double", "60"],
      ]);
      const items = listItems(shown.form, {
        dataSourceId: seeded.created.dataSourceId,
        rows: derived.rows,
        groups: derived.groups,
        hasMore: false,
        optionHint: noHint,
        zone: ZONE,
      });
      expect(items).toHaveLength(25);
      session.setInput(null);
    }),
  ),
);

it.effect("groups a view and continues one bucket", () =>
  fixture((c) =>
    Effect.promise(async () => {
      const seeded = await seed(c);
      const viewId = await seeded.view({
        name: "By priority",
        type: "board",
        group: { property: ids.prio },
        properties: [{ propertyId: ids.points, visible: true }],
      });
      const shown = await form(c, seeded, viewId);
      expect(shown.form).toMatchObject({ kind: "board", mode: "groups", rowsPerGroup: 10 });
      const input = formQueryInput(shown.form, shown.saved, {
        environmentId: c.environmentId,
        timeZone: ZONE,
      });
      expect(input.subGroup).toBeNull();
      const session = c.viewSession();
      session.setInput(input);
      const first = await c.settled(session, (snapshot) => snapshot.status === "ready");
      const low = first.windows.groups.find((bucket) => bucket.key.optionId === options.low.id);
      expect(low).toMatchObject({ count: 15 });
      expect(low.rows).toHaveLength(10);
      expect(low.nextCursor).not.toBeNull();
      const before = listItems(shown.form, {
        dataSourceId: seeded.created.dataSourceId,
        rows: [],
        groups: first.windows.groups,
        hasMore: false,
        optionHint: noHint,
        zone: ZONE,
      });
      expect(before.filter((item) => item.kind === "more")).toHaveLength(2);
      session.loadBucket(low.key);
      const after = await c.settled(
        session,
        (snapshot) =>
          snapshot.windows.groups.find((bucket) => bucket.key.optionId === options.low.id).rows
            .length === 15,
      );
      const grown = after.windows.groups.find((bucket) => bucket.key.optionId === options.low.id);
      expect(grown.nextCursor).toBeNull();
      expect(new Set(grown.rows.map((row) => row.page.id)).size).toBe(15);
      session.setInput(null);
    }),
  ),
);

it.effect("shows a calendar month as an agenda from a range query", () =>
  fixture((c) =>
    Effect.promise(async () => {
      const seeded = await seed(c);
      const viewId = await seeded.view({
        name: "Calendar",
        type: "calendar",
        layout: { datePropertyId: ids.due },
      });
      const shown = await form(c, seeded, viewId);
      expect(shown.form.kind).toBe("agenda");
      const input = formQueryInput(shown.form, shown.saved, {
        environmentId: c.environmentId,
        timeZone: ZONE,
        month: "2026-11-01",
      });
      const session = c.viewSession();
      session.setInput(input);
      const ready = await c.settled(session, (snapshot) => snapshot.status === "ready");
      // Task 1 (Oct 31) and Task 5 (Dec 1) are outside November, and so are the 25 rows with no date.
      expect(ready.windows.rows.map((row) => row.cells.title).sort()).toEqual([
        "Task 2",
        "Task 3",
        "Task 4",
      ]);
      const sections = agendaSections(ready.windows.rows, ids.due, null, "2026-11-01", ZONE);
      expect(
        sections.map((section) => [section.day, section.items.map((item) => item.row.cells.title)]),
      ).toEqual([
        ["2026-11-01", ["Task 3"]],
        ["2026-11-05", ["Task 2"]],
        ["2026-11-30", ["Task 4"]],
      ]);
      session.setInput(null);
    }),
  ),
);

it.effect("opens a row with its properties and resolves its page with the host as ancestor", () =>
  fixture((c) =>
    Effect.promise(async () => {
      const seeded = await seed(c);
      const rowId = seeded.rowIds[29];
      const row = await c.read(
        c.databases.row({
          environmentId: c.environmentId,
          input: { environmentId: c.environmentId, pageId: rowId, timeZone: ZONE },
        }),
      );
      expect(row).toMatchObject({ template: false });
      expect(row.row.cells.title).toBe("Task 30");
      expect(row.row.cells[ids.points]).toBe(30);
      expect(row.row.cells[ids.calc]).toEqual({ type: "number", value: 60 });
      expect(row.dataSource.databaseId).toBe(seeded.created.databaseId);
      const location = await c.read(
        c.atoms.location({
          environmentId: c.environmentId,
          input: { environmentId: c.environmentId, pageId: rowId, version: 2 },
        }),
      );
      expect(location.page.row).toEqual({ dataSourceId: seeded.created.dataSourceId });
      expect(location.ancestors.map((page) => page.id)).toContain(seeded.host.id);
      expect(location.current()).not.toBeNull();
    }),
  ),
);

it.effect("keeps a database block byte for byte when the page is saved from the mobile draft", () =>
  fixture((c) =>
    Effect.promise(async () => {
      const seeded = await seed(c);
      const key = { environmentId: c.environmentId, pageId: seeded.host.id };
      const current = await c.run(c.service.getPage(key));
      const todo = {
        id: SpaceBlockId.make("native-todo"),
        type: "todo_item",
        version: 1,
        parentId: null,
        order: "f0000000000000000000000000000000",
        content: { checked: false, runs: run("Keep task") },
      };
      const seededTodo = await c.run(
        c.service.applyBlockBatch({
          ...key,
          ...c.common,
          mutationId: c.next("todo"),
          baseRevision: current.page.revision,
          generation: 1,
          mutations: [{ kind: "insert", block: todo }],
        }),
      );
      expect(seededTodo.status).toBe("saved");
      const window = await c.run(
        c.service.readBlocks({ ...key, revision: seededTodo.revision, limit: 100 }),
      );
      const before = window.blocks.find((block) => isSpaceDatabaseBlock(block));
      expect(before).toBeDefined();
      const doc = new SpaceDocumentSession(key, {
        drafts: c.store,
        createMutationId: () => c.next("save"),
        maxLoadedBlocks: 100,
        maxMutations: 100,
        adapter: createSpaceServiceSessionAdapter(key, {
          getPage: (input) => c.run(c.service.getPage(input)),
          limits: () => c.capability.limits,
          applyBlockBatch: (input) => c.run(c.service.applyBlockBatch(input)),
          lookupMutationReceipt: (input) => c.run(c.service.lookupMutationReceipt(input)),
        }),
      });
      const editing = new MobileSpaceEditing({
        session: doc,
        access: () => ({ availability: "writable", capability: c.capability, current: () => true }),
        readWindow: async () => window,
      });
      await doc.hydrate(window);
      expect(() => editing.focus(Symbol(), before.id)).toThrow();
      expect(editing.canDeleteCoreBlock(before.id)).toBe(false);
      editing.toggleTodo(todo.id);
      await editing.save();
      expect(editing.getSnapshot().error).toBeNull();
      const saved = await c.run(c.service.getPage(key));
      const after = await c.run(
        c.service.readBlocks({ ...key, revision: saved.page.revision, limit: 100 }),
      );
      expect(after.blocks.find((block) => block.id === todo.id).content.checked).toBe(true);
      expect(JSON.stringify(after.blocks.find((block) => block.id === before.id))).toBe(
        JSON.stringify(before),
      );
      const views = resolveBlockViews(
        before.content.viewIds,
        (await databaseOf(c, seeded.created.databaseId)).views,
      );
      expect(views).toHaveLength(1);
    }),
  ),
);

const rowOf = (c, pageId) =>
  c.read(
    c.databases.row({
      environmentId: c.environmentId,
      input: { environmentId: c.environmentId, pageId, timeZone: ZONE },
    }),
  );

const highView = (seeded) =>
  seeded.view({
    name: "High",
    type: "table",
    filter: { property: ids.prio, operator: "equals", value: options.high.id },
    sorts: [{ property: "title", direction: "ascending" }],
    properties: [
      { propertyId: ids.points, visible: true },
      { propertyId: ids.prio, visible: true },
    ],
  });

const openView = async (c, seeded, viewId) => {
  const shown = await form(c, seeded, viewId);
  const input = formQueryInput(shown.form, shown.saved, {
    environmentId: c.environmentId,
    timeZone: ZONE,
  });
  const session = c.viewSession();
  session.setInput(input);
  const ready = await c.settled(session, (snapshot) => snapshot.status === "ready");
  return { session, shown, ready };
};

it.effect(
  "a cell edit shows at once, reaches the server and is reflected by the session after the ack",
  () =>
    fixture((c) =>
      Effect.promise(async () => {
        c.permissions(true, true);
        const seeded = await seed(c);
        const { session, ready } = await openView(c, seeded, await highView(seeded));
        expect(ready.windows.total).toBe(15);
        const stopAcks = c.writer.onAck((ack) =>
          session.noteAck({
            dataRevision: ack.dataRevision,
            // Points is neither filtered, sorted nor grouped by this view.
            affects: ack.propertyIds.has(ids.prio),
            structural: ack.structural,
            edits: ack.edits,
          }),
        );
        // Task 2 is the first High row.
        const target = seeded.rowIds[1];
        const pointsEditor = editorFor(
          {
            id: ids.points,
            name: "Points",
            type: "number",
            config: { format: "number" },
            position: 0,
          },
          2,
        );
        const committed = commitValue(pointsEditor, { kind: "text", text: "99" });
        expect(committed).toEqual({ ok: true, value: 99 });
        c.writer.editCell({
          dataSourceId: seeded.created.dataSourceId,
          pageId: target,
          propertyId: ids.points,
          value: committed.value,
        });
        const pendingRows = deriveViewRows({
          mode: "rows",
          dataSourceId: seeded.created.dataSourceId,
          snapshot: session.getSnapshot(),
          writerPending: c.writer.getSnapshot().pending,
        }).rows;
        expect(pendingRows.find((row) => row.page.id === target).cells[ids.points]).toBe(99);
        // Nothing has reached the server yet.
        expect((await rowOf(c, target)).row.cells[ids.points]).toBe(2);

        await c.writer.flush();
        expect(c.writer.getSnapshot().pending).toEqual({});
        const settled = deriveViewRows({
          mode: "rows",
          dataSourceId: seeded.created.dataSourceId,
          snapshot: session.getSnapshot(),
          writerPending: c.writer.getSnapshot().pending,
        }).rows;
        expect(settled.find((row) => row.page.id === target).cells[ids.points]).toBe(99);
        const saved = await rowOf(c, target);
        expect(saved.row.cells[ids.points]).toBe(99);
        expect(c.calls.filter((entry) => entry.tag === "rowsUpdate")).toHaveLength(1);

        // The row page keeps the acknowledged value until its own answer catches up.
        const staleAnswer = {
          row: { ...saved.row, cells: { ...saved.row.cells, [ids.points]: 2 } },
        };
        const acked = recordAck(
          [],
          {
            dataRevision: saved.dataSource.dataRevision + 1,
            edits: [
              {
                dataSourceId: seeded.created.dataSourceId,
                pageId: target,
                propertyId: ids.points,
                value: 99,
                seq: 1,
              },
            ],
          },
          target,
        );
        expect(acked).toHaveLength(1);
        expect(
          patchRowCells(
            { ...staleAnswer, dataSource: { dataRevision: saved.dataSource.dataRevision } },
            {},
            acked,
          )[ids.points],
        ).toBe(99);

        // Changing the filtered priority is a dependency: the session asks again and the row leaves.
        c.writer.editCell({
          dataSourceId: seeded.created.dataSourceId,
          pageId: target,
          propertyId: ids.prio,
          value: options.low.id,
        });
        await c.writer.flush();
        for (const task of Array.from(c.timers)) task();
        const refreshed = await c.settled(
          session,
          (snapshot) => snapshot.status === "ready" && snapshot.windows.total === 14,
        );
        expect(refreshed.windows.rows.map((row) => row.page.id)).not.toContain(target);
        stopAcks();
        session.setInput(null);
      }),
    ),
);

it.effect("adds a row from a filtered view so that the view returns it", () =>
  fixture((c) =>
    Effect.promise(async () => {
      c.permissions(true, true);
      const seeded = await seed(c);
      const { session, shown, ready } = await openView(c, seeded, await highView(seeded));
      expect(ready.windows.total).toBe(15);
      const result = await addRow({
        environmentId: c.environmentId,
        registry: c.registry,
        mutations: c.mutations,
        writer: c.writer,
        canWrite: () => true,
        view: shown.saved,
        dataSource: shown.dataSource,
        title: "  Fresh row  ",
        now: Date.UTC(2026, 10, 11),
        zone: ZONE,
      });
      expect(result).toEqual({ ok: true });
      session.refresh();
      for (const task of Array.from(c.timers)) task();
      const after = await c.settled(session, (snapshot) => snapshot.windows?.total === 16);
      const fresh = after.windows.rows.find((row) => row.cells.title === "Fresh row");
      // The filter's priority was seeded into the new row.
      expect(fresh.cells[ids.prio]).toBe(options.high.id);
      session.setInput(null);

      const refused = await addRow({
        environmentId: c.environmentId,
        registry: c.registry,
        mutations: c.mutations,
        writer: c.writer,
        canWrite: () => false,
        view: shown.saved,
        dataSource: shown.dataSource,
        title: "Nope",
        now: 0,
        zone: ZONE,
      });
      expect(refused.ok).toBe(false);
      expect(c.calls.filter((entry) => entry.tag === "rowsCreate")).toHaveLength(1);
    }),
  ),
);

it.effect("drops a refused value, reports it, and leaves the row as it was", () =>
  fixture((c) =>
    Effect.promise(async () => {
      c.permissions(true, true);
      const seeded = await seed(c);
      const target = seeded.rowIds[0];
      c.writer.editCell({
        dataSourceId: seeded.created.dataSourceId,
        pageId: target,
        propertyId: ids.prio,
        value: "no-such-option",
      });
      await c.writer.flush();
      expect(c.writer.getSnapshot()).toMatchObject({ pending: {}, failed: 0 });
      expect(c.failures.getSnapshot()).toHaveLength(1);
      expect((await rowOf(c, target)).row.cells[ids.prio]).toBe(options.low.id);
    }),
  ),
);

it.effect(
  "refuses a write for a read-only session with the scope error and keeps it for retry",
  () =>
    fixture((c) =>
      Effect.promise(async () => {
        const seeded = await seed(c);
        const target = seeded.rowIds[0];
        await expect(
          c.mutations.updateRows(c.registry, c.environmentId, {
            dataSourceId: seeded.created.dataSourceId,
            rows: [{ pageId: target, cells: { [ids.points]: 7 } }],
          }),
        ).rejects.toMatchObject({ _tag: "EnvironmentAuthorizationError" });

        c.writer.editCell({
          dataSourceId: seeded.created.dataSourceId,
          pageId: target,
          propertyId: ids.points,
          value: 7,
        });
        await c.writer.flush();
        // Not a refused value: the edit stays shown and waits for Retry or Discard.
        expect(c.writer.getSnapshot().failed).toBe(1);
        expect(Object.keys(c.writer.getSnapshot().pending)).toHaveLength(1);
        expect(c.failures.getSnapshot()).toEqual([]);
        expect(c.calls.filter((entry) => entry.tag === "rowsUpdate")).toHaveLength(0);
        c.writer.discardFailed();
        expect(c.writer.getSnapshot()).toMatchObject({ pending: {}, failed: 0 });
        expect((await rowOf(c, target)).row.cells[ids.points]).toBe(1);

        // Once the grant is back, the same edit goes through.
        c.permissions(true, true);
        c.writer.editCell({
          dataSourceId: seeded.created.dataSourceId,
          pageId: target,
          propertyId: ids.points,
          value: 7,
        });
        await c.writer.flush();
        expect((await rowOf(c, target)).row.cells[ids.points]).toBe(7);
      }),
    ),
);
