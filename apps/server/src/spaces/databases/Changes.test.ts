import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { MAILBOX_LIMIT, makeHub, type ChangeBatch } from "./Changes.ts";

const source = (id: string, dataRevision: number, schemaRevision = 0) => ({
  id,
  databaseId: "db",
  schemaRevision,
  dataRevision,
});
const batch = (...dataSources: ChangeBatch["dataSources"][number][]): ChangeBatch => ({
  dataSources,
  databases: [],
});

// One subscriber that is read only when the test pulls, so ordering never depends on scheduling.
const subscribe = Effect.fn("ChangesTest.subscribe")(function* (hub: ReturnType<typeof makeHub>) {
  const pull = yield* Stream.toPull(hub.subscribe);
  const first = yield* pull;
  assert.deepEqual(first as ReadonlyArray<unknown>, [{ type: "resync" }]);
  return pull;
});

it.effect("conflates batches for one subscriber and keeps the newest revisions", () =>
  Effect.gen(function* () {
    const hub = makeHub();
    const pull = yield* subscribe(hub);
    yield* hub.publish(batch(source("a", 1), source("b", 1)));
    yield* hub.publish({
      dataSources: [source("a", 2, 1)],
      databases: [{ id: "db", revision: 3 }],
    });
    const events = yield* pull;
    assert.deepEqual(events as ReadonlyArray<unknown>, [
      {
        type: "changed",
        dataSources: [
          { id: "a", databaseId: "db", schemaRevision: 1, dataRevision: 2 },
          { id: "b", databaseId: "db", schemaRevision: 0, dataRevision: 1 },
        ],
        databases: [{ id: "db", revision: 3 }],
      },
    ]);
  }).pipe(Effect.scoped),
);

it.effect("collapses a mailbox past its limit to one resync and recovers afterwards", () =>
  Effect.gen(function* () {
    const hub = makeHub();
    const pull = yield* subscribe(hub);
    yield* hub.publish(
      batch(...Array.from({ length: MAILBOX_LIMIT + 1 }, (_, i) => source(`s${i}`, 1))),
    );
    yield* hub.publish(batch(source("late", 1)));
    assert.deepEqual((yield* pull) as ReadonlyArray<unknown>, [{ type: "resync" }]);
    yield* hub.publish(batch(source("after", 5)));
    const events = yield* pull;
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type === "changed" ? events[0].dataSources[0]?.id : "", "after");
  }).pipe(Effect.scoped),
);

it.effect("splits an event over 256 entries and sends each id once", () =>
  Effect.gen(function* () {
    const hub = makeHub();
    const pull = yield* subscribe(hub);
    yield* hub.publish(batch(...Array.from({ length: 300 }, (_, i) => source(`s${i}`, 1))));
    const events = yield* pull;
    const sizes = events.map((event) => (event.type === "changed" ? event.dataSources.length : 0));
    assert.deepEqual(sizes, [256, 44]);
  }).pipe(Effect.scoped),
);

it.effect("never blocks publish on a subscriber that does not read, and forgets it on close", () =>
  Effect.gen(function* () {
    const hub = makeHub();
    const scope = yield* Scope.make();
    const closed = Scope.provide(scope);
    const pull = yield* closed(Stream.toPull(hub.subscribe));
    yield* pull;
    for (let i = 0; i < 2000; i++) yield* hub.publish(batch(source(`s${i}`, 1)));
    yield* Scope.close(scope, Exit.void);
    // A subscriber that joins after the close sees only the opening resync.
    const fresh = yield* subscribe(hub);
    yield* hub.publish(batch(source("x", 1)));
    const events = yield* fresh;
    assert.equal(events.length, 1);
  }).pipe(Effect.scoped),
);
