import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";

import { databaseError, limitError } from "./Databases.testkit.ts";
import { NAMES, ids, seed } from "./DatabaseQuery.testkit.ts";
import { fixture } from "./Spaces.testkit.ts";

const [Al, Br, Ch, De, Ec, Fo, Em] = NAMES;
const titleId = C.SpacePropertyId.make("title");
const asc = (property: C.SpacePropertyId): C.SpaceSort => ({ property, direction: "ascending" });
const desc = (property: C.SpacePropertyId): C.SpaceSort => ({ property, direction: "descending" });

const rows: readonly (readonly [string, readonly C.SpaceSort[], readonly string[]])[] = [
  ["no sort is manual order", [], NAMES],
  ["title ascending, empty last", [asc(titleId)], [Al, Br, Ch, De, Ec, Fo, Em]],
  ["title descending, empty still last", [desc(titleId)], [Fo, Ec, De, Ch, Br, Al, Em]],
  [
    "number ascending, ties by manual order, empty last",
    [asc(ids.points)],
    [Fo, Em, Al, Br, Ec, Ch, De],
  ],
  ["number descending", [desc(ids.points)], [Ch, Br, Ec, Al, Em, Fo, De]],
  ["select by option order, not alphabet", [asc(ids.prio)], [Al, Ec, Br, Fo, Ch, Em, De]],
  ["select descending", [desc(ids.prio)], [Ch, Em, Br, Fo, Al, Ec, De]],
  ["status by group rank then option order", [asc(ids.state)], [Al, De, Br, Ec, Ch, Fo, Em]],
  ["multi_select by its first option", [asc(ids.tags)], [Al, De, Br, Ec, Em, Ch, Fo]],
  ["checkbox, unchecked first", [asc(ids.done)], [Br, De, Ec, Em, Al, Ch, Fo]],
  ["checkbox descending", [desc(ids.done)], [Al, Ch, Fo, Br, De, Ec, Em]],
  ["date by start", [asc(ids.due)], [De, Al, Br, Ec, Ch, Em, Fo]],
  ["text by folded text", [asc(ids.note)], [Br, Fo, Al, De, Ec, Em, Ch]],
  ["url", [asc(ids.link)], [Al, Br, Ec, Fo, Ch, De, Em]],
  ["files by first file name", [asc(ids.files)], [Ch, Al, Br, De, Ec, Fo, Em]],
  ["relation by first target title", [asc(ids.project)], [Al, Br, Ec, Ch, De, Fo, Em]],
  ["created_time descending", [desc(ids.created)], [Em, Fo, Ec, De, Ch, Br, Al]],
  ["last_edited_time ascending", [asc(ids.edited)], [Al, Ch, De, Ec, Fo, Em, Br]],
  ["unique_id descending", [desc(ids.number)], [Em, Fo, Ec, De, Ch, Br, Al]],
  [
    "two keys: select then number descending",
    [asc(ids.prio), desc(ids.points)],
    [Ec, Al, Br, Fo, Ch, Em, De],
  ],
  [
    "three keys: checkbox, select descending, title",
    [asc(ids.done), desc(ids.prio), asc(titleId)],
    [Em, Br, Ec, De, Ch, Fo, Al],
  ],
];

it.layer(NodeServices.layer)("Spaces database query sorts", (it) => {
  it.effect("orders every sortable type with a stable tiebreak", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { query, titles } = yield* seed(dbPath);
        for (const [label, sorts, expected] of rows)
          assert.deepEqual(titles(yield* query({ sorts })), [...expected], label);
      }),
    ),
  );

  it.effect("rejects sorts it cannot run", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { query } = yield* seed(dbPath);
        const reason = (sorts: readonly C.SpaceSort[]) =>
          Effect.map(databaseError(query({ sorts })), (error) => error.reason);
        assert.equal(yield* reason([asc(ids.calc)]), "property_not_queryable");
        assert.equal(yield* reason([asc(ids.points), desc(ids.points)]), "invalid_sort");
        const nine = [
          titleId,
          ids.note,
          ids.points,
          ids.done,
          ids.link,
          ids.prio,
          ids.tags,
          ids.state,
          ids.due,
        ].map(asc);
        assert.equal(yield* limitError(query({ sorts: nine })), "databases.maxSorts");
        const sideways = yield* Effect.flip(
          query({ sorts: [{ property: ids.points, direction: "sideways" } as never] }),
        );
        assert.equal(sideways._tag, "SpaceValidationError");
      }),
    ),
  );
});
