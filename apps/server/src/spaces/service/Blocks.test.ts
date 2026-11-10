import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as C from "@t2code/contracts/spaces";
import * as NodeSqliteClient from "@t2code/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Settings from "../../serverSettings.ts";
import * as SpacesService from "../SpacesService.ts";
import {
  env,
  identity,
  block,
  encodeServiceErrorJson,
  encodeBlockJson,
  bytes,
  fixture,
  boot,
  structureState,
  rootPage,
  blockMoveIntent,
} from "./Spaces.testkit.ts";

it.layer(NodeServices.layer)("Spaces core service", (it) => {
  it.effect("lets title edits and block edits land on either side of each other", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service, common, page, request } = yield* boot();
        const titled = (mutationId: string, baseRevision: number, title: string) =>
          service.updatePage({ ...common, mutationId, pageId: page.id, baseRevision, title });
        assert.equal((yield* titled("rename-1", 0, "One")).status, "saved");
        assert.equal(
          (yield* service.applyBlockBatch(
            request("body-1", 0, [{ kind: "insert", block: block("meta-1", 1) }]),
          )).status,
          "saved",
        );
        assert.equal((yield* titled("rename-2", 0, "Two")).status, "saved");
        assert.equal(
          (yield* service.applyBlockBatch(
            request("body-2", 0, [{ kind: "insert", block: block("meta-2", 2) }]),
          )).status,
          "conflict",
        );
        assert.equal((yield* titled("rename-3", 99, "Three")).status, "conflict");
        assert.equal((yield* service.getPage({ ...env, pageId: page.id })).page.title, "Two");
      }),
    ),
  );

  it.effect("leaves genuine defects as defects instead of reporting a storage outage", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { service, page, request } = yield* boot();
        yield* service.applyBlockBatch(
          request("corrupt", 0, [{ kind: "insert", block: block("corrupt-me", 1) }]),
        );
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE spaces_blocks SET payload = '123' WHERE block_id = 'corrupt-me'`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
        const exit = yield* Effect.exit(
          service.readBlocks({ ...env, pageId: page.id, revision: 1 }),
        );
        assert.isTrue(Exit.isFailure(exit) && Cause.hasDies(exit.cause));
      }),
    ),
  );

  it.effect(
    "preserves exact UTF-8 titles and block envelopes at the byte boundary, rejecting one byte over atomically",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const { service, common, request, page } = yield* boot();
          const title = "界".repeat(170);
          assert.equal(bytes(title), 512);
          const savedTitle = yield* service.updatePage({
            ...common,
            pageId: page.id,
            mutationId: "title",
            baseRevision: 0,
            title,
          });
          assert.equal(savedTitle.status, "saved");
          const badTitle = {
            ...common,
            pageId: page.id,
            mutationId: "bad-title",
            baseRevision: 1,
            title: title + "a",
          };
          const failure = yield* Effect.flip(service.updatePage(badTitle));
          assert.equal(failure._tag, "SpaceLimitExceededError");
          const small = {
            ...block("a"),
            content: { runs: [{ text: "", marks: [] }] },
            opaque: { future: "kept" },
          };
          const room = 32_768 - bytes(small);
          const text =
            "界".repeat(Math.floor((room - 16) / 3)) +
            "x".repeat(room - 3 * Math.floor((room - 16) / 3));
          const exact = { ...small, content: { runs: [{ text, marks: [] }] } };
          assert.equal(bytes(exact), 32_768);
          yield* service.applyBlockBatch(request("exact", 1, [{ kind: "insert", block: exact }]));
          assert.deepEqual(
            (yield* service.readBlocks({ ...env, pageId: page.id, revision: 2 })).blocks,
            [exact],
          );
          const oversized = { ...exact, content: { runs: [{ text: text + "x", marks: [] }] } };
          const bad = request("too-large", 2, [{ kind: "replace", block: oversized }]);
          const blockError = yield* Effect.flip(service.applyBlockBatch(bad));
          assert.equal(blockError._tag, "SpaceLimitExceededError");
          assert.deepEqual(
            yield* service.lookupMutationReceipt({
              request: { operation: "applyBlockBatch", input: bad },
            }),
            { status: "absent" },
          );
          assert.equal((yield* service.getPage({ ...env, pageId: page.id })).page.title, title);
          assert.deepEqual(
            (yield* service.readBlocks({ ...env, pageId: page.id, revision: 2 })).blocks,
            [exact],
          );
        }),
      ),
  );

  it.effect(
    "validates the final graph, preserves unloaded children, and retains durable minimal merge identities",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, request, page, common, library } = yield* boot();
          const parent = { ...block("parent"), type: "bulleted_item" };
          const child = block("child", 1, parent.id);
          const other = block("other", 2);
          yield* service.applyBlockBatch(
            request(
              "initial",
              0,
              [parent, child, other].map((value) => ({ kind: "insert", block: value })),
            ),
          );
          const window = yield* service.readBlocks({
            ...env,
            pageId: page.id,
            revision: 1,
            limit: 1,
          });
          assert.deepEqual(window.blocks, [parent]);
          assert.isNotNull(window.nextCursor);
          const next = yield* service.readBlocks({
            ...env,
            pageId: page.id,
            revision: 1,
            limit: 1,
            cursor: window.nextCursor,
          });
          assert.deepEqual(next.blocks, [child]);
          const bad = request("parent-delete", 1, [{ kind: "delete", blockId: parent.id }]);
          const failure = yield* Effect.flip(service.applyBlockBatch(bad));
          assert.equal(failure._tag, "SpaceValidationError");
          assert.deepEqual(
            yield* service.lookupMutationReceipt({
              request: { operation: "applyBlockBatch", input: bad },
            }),
            { status: "absent" },
          );
          yield* service.applyBlockBatch(
            request("edit-window", 1, [
              {
                kind: "replace",
                block: { ...parent, content: { runs: [{ text: "Edited", marks: [] }] } },
              },
            ]),
          );
          const complete = yield* service.readBlocks({ ...env, pageId: page.id, revision: 2 });
          assert.deepEqual(complete.blocks.slice(1), [child, other]);
          assert.equal(
            (yield* Effect.flip(
              service.readBlocks({
                ...env,
                pageId: page.id,
                revision: 2,
                cursor: window.nextCursor,
              }),
            ))._tag,
            "SpaceCursorStaleError",
          );
          const second = yield* service.createPage({
            ...common,
            mutationId: "second-page",
            spaceId: library.defaultSpaceId,
            baseRootOrderRevision: 1,
            title: "Second",
          });
          assert.equal(second.status, "saved");
          if (second.status !== "saved") return;
          assert.equal(
            (yield* Effect.flip(
              service.applyBlockBatch({
                ...request("cross-page", 0, [{ kind: "insert", block: block("child") }]),
                pageId: second.page.id,
              }),
            ))._tag,
            "SpaceValidationError",
          );
          assert.equal(
            (yield* Effect.flip(
              service.applyBlockBatch({
                ...request("cross-parent", 0, [
                  { kind: "insert", block: block("new-child", 1, parent.id) },
                ]),
                pageId: second.page.id,
              }),
            ))._tag,
            "SpaceValidationError",
          );
          yield* service.applyBlockBatch(
            request("join", 2, [{ kind: "delete", blockId: child.id, mergedInto: other.id }]),
          );
          assert.equal(
            (yield* Effect.flip(
              service.applyBlockBatch(
                request("resurrection", 3, [{ kind: "insert", block: child }]),
              ),
            ))._tag,
            "SpaceValidationError",
          );
          yield* service.applyBlockBatch(
            request("reparent-final", 3, [
              { kind: "delete", blockId: parent.id },
              { kind: "replace", block: { ...other, parentId: null } },
            ]),
          );
          assert.deepEqual(
            (yield* service.readBlocks({ ...env, pageId: page.id, revision: 4 })).blocks,
            [other],
          );
          // Independent storage inspection verifies the retained identity link and logical accounting.
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const [tombstone] = yield* sql<{
              readonly merged_into: string;
              readonly deleted: number;
            }>`SELECT merged_into, deleted FROM spaces_ids WHERE id = 'child'`;
            assert.equal(tombstone?.merged_into, other.id);
            assert.equal(tombstone?.deleted, 1);
            assert.deepEqual(yield* sql`SELECT 1 FROM spaces_blocks WHERE block_id='child'`, []);
            const [counters] = yield* sql<{
              readonly block_count: number;
              readonly block_bytes: number;
            }>`SELECT block_count, block_bytes FROM spaces_pages WHERE page_id = ${page.id}`;
            const rows = yield* sql<{
              readonly payload: string;
            }>`SELECT payload FROM spaces_blocks WHERE page_id = ${page.id}`;
            assert.equal(counters?.block_count, 1);
            assert.equal(
              counters?.block_bytes,
              rows.reduce((sum, row) => sum + Buffer.byteLength(row.payload, "utf8"), 0),
            );
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
        }),
      ),
  );

  it.effect(
    "rejects cycles, non-list parents, duplicate IDs and excessive induced depth without partial commits",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const { service, request, page } = yield* boot();
          const parent = { ...block("parent"), type: "bulleted_item" };
          for (const [name, mutations, reason] of [
            [
              "duplicate",
              [
                { kind: "insert", block: parent },
                { kind: "insert", block: parent },
              ],
              "duplicate_id",
            ],
            [
              "parent",
              [
                { kind: "insert", block: block("leaf") },
                { kind: "insert", block: block("child", 1, C.SpaceBlockId.make("leaf")) },
              ],
              "invalid_parent",
            ],
            [
              "cycle",
              [
                { kind: "insert", block: { ...parent, parentId: C.SpaceBlockId.make("child") } },
                {
                  kind: "insert",
                  block: { ...block("child", 1, parent.id), type: "bulleted_item" },
                },
              ],
              "cycle",
            ],
            [
              "order",
              [{ kind: "insert", block: { ...parent, order: "arbitrary" } }],
              "invalid_order",
            ],
          ] as const) {
            const input = request(name, 0, mutations);
            const error = yield* Effect.flip(service.applyBlockBatch(input));
            assert.equal(error._tag, "SpaceValidationError");
            if (error._tag === "SpaceValidationError") assert.equal(error.reason, reason);
            assert.deepEqual(
              yield* service.lookupMutationReceipt({
                request: { operation: "applyBlockBatch", input },
              }),
              { status: "absent" },
            );
          }
          const chain = Array.from({ length: 16 }, (_, i) => ({
            ...block(`depth-${i}`, 1, i === 0 ? null : C.SpaceBlockId.make(`depth-${i - 1}`)),
            type: "bulleted_item",
          }));
          yield* service.applyBlockBatch(
            request(
              "depth",
              0,
              chain.map((value) => ({ kind: "insert", block: value })),
            ),
          );
          const deep = request("too-deep", 1, [
            { kind: "insert", block: block("depth-16", 1, chain[15]!.id) },
          ]);
          const error = yield* Effect.flip(service.applyBlockBatch(deep));
          assert.equal(error._tag, "SpaceLimitExceededError");
          if (error._tag === "SpaceLimitExceededError") assert.equal(error.limit, "maxDepth");
          assert.equal(
            (yield* service.readBlocks({ ...env, pageId: page.id, revision: 1 })).blocks.length,
            16,
          );
          // A new parent above an existing deep subtree must validate unloaded descendants too.
          const induced = request("induced-depth", 1, [
            { kind: "insert", block: { ...block("new-root"), type: "bulleted_item" } },
            { kind: "replace", block: { ...chain[0]!, parentId: C.SpaceBlockId.make("new-root") } },
          ]);
          assert.equal(
            (yield* Effect.flip(service.applyBlockBatch(induced)))._tag,
            "SpaceLimitExceededError",
          );
          assert.equal((yield* service.getPage({ ...env, pageId: page.id })).page.revision, 1);
        }),
      ),
  );

  it.effect(
    "preserves opaque fields through reads and unrelated edits and refuses stripping or unsupported creation",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const { service, request, page } = yield* boot();
          const rich = {
            ...block("opaque"),
            extension: { future: [1, "界"] },
            content: {
              runs: [
                { text: "old", marks: [{ type: "bold", version: 1, extra: "mark" }], extra: "run" },
              ],
              future: "content",
            },
          };
          yield* service.applyBlockBatch(request("opaque", 0, [{ kind: "insert", block: rich }]));
          const edited = {
            ...rich,
            content: { ...rich.content, runs: [{ ...rich.content.runs[0]!, text: "new" }] },
          };
          yield* service.applyBlockBatch(
            request("edit", 1, [
              { kind: "replace", block: edited },
              { kind: "insert", block: block("other", 2) },
            ]),
          );
          assert.deepEqual(
            (yield* service.readBlocks({ ...env, pageId: page.id, revision: 2 })).blocks[0],
            edited,
          );
          for (const stripped of [
            { ...edited, extension: null },
            { ...edited, content: { runs: edited.content.runs } },
            { ...edited, content: { ...edited.content, runs: [{ text: "stripped", marks: [] }] } },
          ]) {
            const error = yield* Effect.flip(
              service.applyBlockBatch(request("strip", 2, [{ kind: "replace", block: stripped }])),
            );
            assert.equal(error._tag, "SpaceValidationError");
            if (error._tag === "SpaceValidationError")
              assert.equal(error.reason, "unsupported_block");
          }
          for (const unsupported of [
            { ...block("unsupported"), type: "child_page", content: { pageId: "elsewhere" } },
            { ...block("unsupported"), version: 2 },
            { ...block("unsupported"), type: "future" },
          ])
            assert.equal(
              (yield* Effect.flip(
                service.applyBlockBatch(
                  request("unsupported", 2, [{ kind: "insert", block: unsupported }]),
                ),
              ))._tag,
              "SpaceValidationError",
            );
          assert.deepEqual(
            (yield* service.readBlocks({ ...env, pageId: page.id, revision: 2 })).blocks[0],
            edited,
          );
        }),
      ),
  );

  it.effect(
    "bounds block reads by whole response bytes and keeps revision-bound list cursors and root guards",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const { service, request, page, common, library } = yield* boot();
          const large = Array.from({ length: 10 }, (_, i) => {
            const base = {
              ...block(`large-${i}`, i + 1),
              type: "code",
              content: { text: "", language: "text" },
            };
            return {
              ...base,
              content: { ...base.content, text: "x".repeat(32_768 - bytes(base)) },
            };
          });
          yield* service.applyBlockBatch(
            request(
              "large-a",
              0,
              large.slice(0, 5).map((value) => ({ kind: "insert", block: value })),
            ),
          );
          yield* service.applyBlockBatch(
            request(
              "large-b",
              1,
              large.slice(5).map((value) => ({ kind: "insert", block: value })),
            ),
          );
          const first = yield* service.readBlocks({ ...env, pageId: page.id, revision: 2 });
          assert.equal(first.blocks.length, 7);
          assert.isAtMost(bytes(first), 262_144);
          assert.isNotNull(first.nextCursor);
          const second = yield* service.readBlocks({
            ...env,
            pageId: page.id,
            revision: 2,
            cursor: first.nextCursor,
          });
          assert.deepEqual([...first.blocks, ...second.blocks], large);
          assert.isNull(second.nextCursor);
          assert.equal(
            (yield* Effect.flip(
              service.readBlocks({ ...env, pageId: page.id, revision: 2, limit: 101 }),
            ))._tag,
            "SpaceLimitExceededError",
          );
          const extra = yield* service.createSpace({ ...common, mutationId: "space", title: "" });
          const firstList = yield* service.listSpaces({ ...env, limit: 1 });
          assert.isNotNull(firstList.nextCursor);
          const rest = yield* service.listSpaces({
            ...env,
            cursor: firstList.nextCursor,
            limit: 1,
          });
          assert.equal(rest.items.length, 1);
          assert.equal(new Set([...firstList.items, ...rest.items].map((item) => item.id)).size, 2);
          const staleRoot = yield* service.createPage({
            ...common,
            mutationId: "stale-root",
            spaceId: library.defaultSpaceId,
            baseRootOrderRevision: 0,
            title: "Refused",
          });
          assert.equal(staleRoot.status, "conflict");
          assert.equal(
            (yield* service.listPages({ ...env, spaceId: library.defaultSpaceId })).items.length,
            1,
          );
          yield* service.renameSpace({
            ...common,
            mutationId: "rename",
            spaceId: extra.space.id,
            baseRevision: 0,
            title: "Renamed",
          });
          assert.equal(
            (yield* Effect.flip(service.listSpaces({ ...env, cursor: firstList.nextCursor })))._tag,
            "SpaceCursorStaleError",
          );
          const switched = yield* service.setDefaultSpace({
            ...common,
            mutationId: "default",
            spaceId: extra.space.id,
            baseRevision: 1,
            defaultSpaceId: library.defaultSpaceId,
            baseDefaultRevision: 0,
          });
          assert.equal(switched.status, "saved");
          const after = yield* service.listSpaces(env);
          assert.equal(after.defaultSpaceId, extra.space.id);
          assert.equal(after.items.filter((space) => space.isDefault).length, 1);
        }),
      ),
  );

  it.effect(
    "enforces complete request bytes and induced node limits at their exact persisted boundaries",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const { service, request, page } = yield* boot();
          const values = Array.from({ length: 8 }, (_, i) => {
            const base = {
              ...block(`request-${i}`, i + 1),
              type: "code",
              content: { language: "", text: "" },
            };
            return {
              ...base,
              content: { language: "", text: "x".repeat(i === 7 ? 0 : 32_768 - bytes(base)) },
            };
          });
          const input = request(
            "request-exact",
            0,
            values.map((value) => ({ kind: "insert", block: value })),
          );
          const room = 262_144 - bytes({ operation: "applyBlockBatch", input });
          values[7] = {
            ...values[7]!,
            content: {
              language: "",
              text:
                "界".repeat(Math.floor((room - 16) / 3)) +
                "x".repeat(room - 3 * Math.floor((room - 16) / 3)),
            },
          };
          const exact = request(
            "request-exact",
            0,
            values.map((value) => ({ kind: "insert", block: value })),
          );
          assert.equal(bytes({ operation: "applyBlockBatch", input: exact }), 262_144);
          const result = yield* service.applyBlockBatch(exact);
          assert.equal(result.status, "saved");
          const overValues = [...values];
          overValues[7] = {
            ...values[7]!,
            content: { ...values[7]!.content, text: Reflect.get(values[7]!.content, "text") + "x" },
          };
          const over = request(
            "request-over!",
            1,
            overValues.map((value) => ({ kind: "replace", block: value })),
          );
          // replace adds one byte per operation relative to insert; compensate before testing the boundary.
          const lastText = Reflect.get(overValues[7]!.content, "text") as string;
          overValues[7] = {
            ...overValues[7]!,
            content: { language: "", text: lastText.slice(0, -8) },
          };
          const tooLarge = {
            ...over,
            mutations: overValues.map((value) => ({ kind: "replace" as const, block: value })),
          };
          assert.equal(bytes({ operation: "applyBlockBatch", input: tooLarge }), 262_145);
          const error = yield* Effect.flip(service.applyBlockBatch(tooLarge));
          assert.equal(error._tag, "SpaceLimitExceededError");
          if (error._tag === "SpaceLimitExceededError")
            assert.equal(error.limit, "maxMutationBytes");
          assert.equal((yield* service.getPage({ ...env, pageId: page.id })).page.revision, 1);
          const parent = { ...block("container", 10), type: "bulleted_item" };
          const children = Array.from({ length: 100 }, (_, i) =>
            block(`child-${i}`, i + 1, parent.id),
          );
          yield* service.applyBlockBatch(
            request(
              "nodes-exact",
              1,
              [parent, ...children.slice(0, 99)].map((value) => ({ kind: "insert", block: value })),
            ),
          );
          yield* service.applyBlockBatch(
            request("last-child", 2, [{ kind: "insert", block: children[99]! }]),
          );
          const induced = request("induced", 3, [
            {
              kind: "replace",
              block: { ...parent, content: { runs: [{ text: "Changed", marks: [] }] } },
            },
          ]);
          const inducedError = yield* Effect.flip(service.applyBlockBatch(induced));
          assert.equal(inducedError._tag, "SpaceLimitExceededError");
          if (inducedError._tag === "SpaceLimitExceededError") {
            assert.equal(inducedError.limit, "maxMutationNodes");
            assert.equal(inducedError.actual, 101);
          }
          assert.deepEqual(
            yield* service.lookupMutationReceipt({
              request: { operation: "applyBlockBatch", input: induced },
            }),
            { status: "absent" },
          );
          assert.equal((yield* service.getPage({ ...env, pageId: page.id })).page.revision, 3);
        }),
      ),
  );

  it.effect("enforces final live page bytes atomically without transient-order rejection", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { service, request, page, common, library } = yield* boot();
        const values = Array.from({ length: 1024 }, (_, i) => {
          const base = {
            ...block(`capacity-${i}`, i + 1),
            type: "code",
            content: { language: "", text: "" },
          };
          return { ...base, content: { language: "", text: "x".repeat(32_768 - bytes(base)) } };
        });
        let revision = 0;
        for (let offset = 0; offset < values.length; offset += 7) {
          yield* service.applyBlockBatch(
            request(
              `fill-${offset}`,
              revision++,
              values.slice(offset, offset + 7).map((value) => ({ kind: "insert", block: value })),
            ),
          );
        }
        const over = request("page-byte-over", revision, [
          { kind: "insert", block: block("extra") },
        ]);
        const error = yield* Effect.flip(service.applyBlockBatch(over));
        assert.equal(error._tag, "SpaceLimitExceededError");
        if (error._tag === "SpaceLimitExceededError") assert.equal(error.limit, "maxPageBytes");
        assert.equal((yield* service.getPage({ ...env, pageId: page.id })).page.revision, revision);
        assert.deepEqual(
          yield* service.lookupMutationReceipt({
            request: { operation: "applyBlockBatch", input: over },
          }),
          { status: "absent" },
        );
        const old = values[0]!;
        const base = { ...block("extra"), type: "code", content: { language: "", text: "" } };
        const replacement = {
          ...base,
          content: { language: "", text: "x".repeat(32_768 - bytes(base)) },
        };
        yield* service.applyBlockBatch(
          request("final-state", revision, [
            { kind: "insert", block: replacement },
            { kind: "delete", blockId: old.id },
          ]),
        );
        const first = yield* service.readBlocks({
          ...env,
          pageId: page.id,
          revision: revision + 1,
          limit: 1,
        });
        assert.deepEqual(first.blocks, [replacement]);
        const source = yield* rootPage(service, common, library.defaultSpaceId, "byte-source");
        const moved = block("byte-moved");
        yield* service.applyBlockBatch({
          ...common,
          mutationId: "byte-source-seed",
          pageId: source.id,
          baseRevision: 0,
          generation: 0,
          mutations: [{ kind: "insert", block: moved }],
        });
        const intent = yield* blockMoveIntent(
          service,
          common,
          source.id,
          [moved.id],
          { pageId: page.id, parentId: null, beforeBlockId: null },
          "byte-move-over",
        );
        const before = yield* structureState(dbPath);
        const moveError = yield* Effect.flip(service.moveBlocks(intent));
        assert.equal(moveError._tag, "SpaceLimitExceededError");
        if (moveError._tag === "SpaceLimitExceededError")
          assert.equal(moveError.limit, "maxPageBytes");
        assert.deepEqual(yield* structureState(dbPath), before);
      }),
    ),
  );

  it.effect(
    "releases deleted body charges while keeping IDs reserved and refusing final live count overflow",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, request, page, common, library } = yield* boot();
          for (let offset = 0; offset < 10_000; offset += 100) {
            yield* service.applyBlockBatch(
              request(
                `fill-${offset}`,
                offset / 100,
                Array.from({ length: 100 }, (_, i) => ({
                  kind: "insert" as const,
                  block: block(`count-${offset + i}`, offset + i + 1),
                })),
              ),
            );
          }
          yield* service.applyBlockBatch(
            request("delete", 100, [{ kind: "delete", blockId: C.SpaceBlockId.make("count-0") }]),
          );
          yield* service.applyBlockBatch(
            request("freed-slot", 101, [{ kind: "insert", block: block("freed-slot") }]),
          );
          const over = request("page-count-over", 102, [
            { kind: "insert", block: block("one-too-many") },
          ]);
          const error = yield* Effect.flip(service.applyBlockBatch(over));
          assert.equal(error._tag, "SpaceLimitExceededError");
          if (error._tag === "SpaceLimitExceededError") {
            assert.equal(error.limit, "maxPageBlocks");
            assert.equal(error.actual, 10_001);
          }
          assert.equal((yield* service.getPage({ ...env, pageId: page.id })).page.revision, 102);
          assert.deepEqual(
            yield* service.lookupMutationReceipt({
              request: { operation: "applyBlockBatch", input: over },
            }),
            { status: "absent" },
          );
          const source = yield* rootPage(service, common, library.defaultSpaceId, "count-source");
          const moved = block("count-moved");
          yield* service.applyBlockBatch({
            ...common,
            mutationId: "count-source-seed",
            pageId: source.id,
            baseRevision: 0,
            generation: 0,
            mutations: [{ kind: "insert", block: moved }],
          });
          const intent = yield* blockMoveIntent(
            service,
            common,
            source.id,
            [moved.id],
            { pageId: page.id, parentId: null, beforeBlockId: null },
            "count-move-over",
          );
          const before = yield* structureState(dbPath);
          const moveError = yield* Effect.flip(service.moveBlocks(intent));
          assert.equal(moveError._tag, "SpaceLimitExceededError");
          if (moveError._tag === "SpaceLimitExceededError") {
            assert.equal(moveError.limit, "maxPageBlocks");
            assert.equal(moveError.actual, 10001);
          }
          assert.deepEqual(yield* structureState(dbPath), before);
        }),
      ),
  );

  it.effect.each(["future-widget", "opaque-list"] as const)(
    "opens pre-existing %s payloads losslessly and refuses unsupported changes",
    (kind) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "spaces-future-" });
        const dbPath = path.join(directory, "spaces.sqlite");
        const production = SpacesService.layerFromPath(dbPath).pipe(
          Layer.provide(identity),
          Layer.provide(Settings.layerTest({ spacesEnabled: true })),
        );
        const original = yield* Effect.gen(function* () {
          const { service, request, page } = yield* boot();
          yield* service.applyBlockBatch(
            request("initial", 0, [{ kind: "insert", block: block("future") }]),
          );
          return page;
        }).pipe(Effect.provide(production));
        const future = {
          ...block("future"),
          type: kind === "opaque-list" ? "bulleted_item" : "future-widget",
          version: kind === "opaque-list" ? 1 : 3,
          content:
            kind === "opaque-list"
              ? { future: "opaque-layout" }
              : { nested: ["界", { opaque: true }] },
          envelope: { preserved: 1 },
        };
        // Fixture represents an existing document written by a newer version, which core intentionally cannot create.
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const payload = yield* encodeBlockJson(future);
          yield* sql`UPDATE spaces_blocks SET payload = ${payload}, logical_bytes = ${bytes(future)} WHERE block_id = 'future'`;
          yield* sql`UPDATE spaces_pages SET block_bytes = ${bytes(future)}, revision = 2 WHERE page_id = ${original.id}`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
        yield* Effect.gen(function* () {
          const service = yield* SpacesService.SpacesService;
          const page = yield* service.getPage({ ...env, pageId: original.id });
          const common = {
            ...env,
            pageId: original.id,
            receiptEpoch: page.mutationAdmission.epoch,
          };
          assert.deepEqual(
            (yield* service.readBlocks({ ...env, pageId: original.id, revision: 2 })).blocks,
            [future],
          );
          yield* service.updatePage({
            ...common,
            mutationId: "rename",
            baseRevision: 2,
            title: "Future kept",
          });
          if (kind === "opaque-list") {
            const childInput = {
              ...common,
              mutationId: "opaque-parent",
              baseRevision: 3,
              generation: 0,
              mutations: [{ kind: "insert", block: block("new-child", 1, future.id) }],
            };
            const error = yield* Effect.flip(service.applyBlockBatch(childInput));
            assert.equal(error._tag, "SpaceValidationError");
            if (error._tag === "SpaceValidationError") assert.equal(error.reason, "invalid_parent");
            assert.deepEqual(
              yield* service.lookupMutationReceipt({
                request: { operation: "applyBlockBatch", input: childInput },
              }),
              { status: "absent" },
            );
            const unsupportedParent = {
              ...block("new-parent"),
              type: "bulleted_item",
              content: { future: "opaque-layout" },
            };
            const sameBatch = {
              ...childInput,
              mutationId: "new-opaque-parent",
              mutations: [
                { kind: "insert", block: block("new-child", 1, unsupportedParent.id) },
                { kind: "insert", block: unsupportedParent },
              ],
            };
            const sameBatchError = yield* Effect.flip(service.applyBlockBatch(sameBatch));
            assert.equal(sameBatchError._tag, "SpaceValidationError");
            if (sameBatchError._tag === "SpaceValidationError")
              assert.equal(sameBatchError.reason, "unsupported_block");
            assert.deepEqual(
              yield* service.lookupMutationReceipt({
                request: { operation: "applyBlockBatch", input: sameBatch },
              }),
              { status: "absent" },
            );
            assert.deepEqual(
              (yield* service.readBlocks({ ...env, pageId: original.id, revision: 3 })).blocks,
              [future],
            );
          }
          for (const mutation of [
            { kind: "replace", block: block("future") },
            { kind: "delete", blockId: future.id },
          ] as const) {
            const error = yield* Effect.flip(
              service.applyBlockBatch({
                ...common,
                mutationId: "unsupported-edit",
                baseRevision: 3,
                generation: 0,
                mutations: [mutation],
              }),
            );
            assert.equal(error._tag, "SpaceValidationError");
            if (error._tag === "SpaceValidationError")
              assert.equal(error.reason, "unsupported_block");
          }
          yield* service.applyBlockBatch({
            ...common,
            mutationId: "unrelated",
            baseRevision: 3,
            generation: 0,
            mutations: [{ kind: "insert", block: block("supported", 2) }],
          });
          assert.deepEqual(
            (yield* service.readBlocks({ ...env, pageId: original.id, revision: 4 })).blocks,
            [future, block("supported", 2)],
          );
        }).pipe(Effect.provide(production));
      }),
  );
  it.effect.each(["envelope", "content", "run", "mark"] as const)(
    "preserves own opaque inherited-name fields at the %s boundary",
    (level) =>
      fixture(() =>
        Effect.gen(function* () {
          const { service, request, page } = yield* boot();
          const extensions: Record<string, Schema.Json> = {
            toString: "future-data",
            constructor: { nested: ["界", false, 7] },
            valueOf: 0,
            hasOwnProperty: false,
          };
          const withExtras = (opaque: Record<string, Schema.Json>, text = "old"): C.SpaceBlock => ({
            ...block("inherited"),
            ...(level === "envelope" ? opaque : {}),
            content: {
              ...(level === "content" ? opaque : {}),
              runs: [
                {
                  ...(level === "run" ? opaque : {}),
                  text,
                  marks: [{ ...(level === "mark" ? opaque : {}), type: "bold", version: 1 }],
                },
              ],
            },
          });
          const original = withExtras(extensions);
          yield* service.applyBlockBatch(
            request("own-initial", 0, [{ kind: "insert", block: original }]),
          );
          assert.deepEqual(
            (yield* service.readBlocks({ ...env, pageId: page.id, revision: 1 })).blocks,
            [original],
          );
          const edited = withExtras(extensions, "known-field-edit");
          yield* service.applyBlockBatch(
            request("own-valid", 1, [{ kind: "replace", block: edited }]),
          );
          const badVariants = [
            Object.fromEntries(Object.entries(extensions).filter(([key]) => key !== "toString")),
            { ...extensions, toString: { nested: "changed primitive" } },
            Object.fromEntries(Object.entries(extensions).filter(([key]) => key !== "constructor")),
            { ...extensions, constructor: { nested: ["changed"] } },
            Object.fromEntries(Object.entries(extensions).filter(([key]) => key !== "valueOf")),
            Object.fromEntries(
              Object.entries(extensions).filter(([key]) => key !== "hasOwnProperty"),
            ),
          ];
          for (const [index, opaque] of badVariants.entries()) {
            const input = request(`own-refused-${index}`, 2, [
              { kind: "replace", block: withExtras(opaque, "discarded") },
            ]);
            const error = yield* Effect.flip(service.applyBlockBatch(input));
            assert.equal(error._tag, "SpaceValidationError");
            if (error._tag === "SpaceValidationError")
              assert.equal(error.reason, "unsupported_block");
            assert.deepEqual(
              yield* service.lookupMutationReceipt({
                request: { operation: "applyBlockBatch", input },
              }),
              { status: "absent" },
            );
          }
          assert.equal((yield* service.getPage({ ...env, pageId: page.id })).page.revision, 2);
          assert.deepEqual(
            (yield* service.readBlocks({ ...env, pageId: page.id, revision: 2 })).blocks,
            [edited],
          );
        }),
      ),
  );
  it.effect.each([
    { method: "mutation", size: 500_000 },
    { method: "mutation", size: 256 },
    { method: "lookup", size: 500_000 },
    { method: "lookup", size: 256 },
  ] as const)(
    "bounds missing receipt epoch errors for $method with $size characters",
    ({ method, size }) =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, common, page } = yield* boot();
          const input = {
            ...common,
            mutationId: "huge-epoch",
            receiptEpoch: "x".repeat(size),
            title: "",
          };
          const request = { operation: "createSpace" as const, input };
          assert.isBelow(bytes(request), 1_048_576);
          const inspect = Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return {
              meta: yield* sql`SELECT catalog_revision, receipt_rows, receipt_bytes FROM spaces_core`,
              spaces: yield* sql`SELECT space_id, title, revision FROM spaces ORDER BY space_id`,
              page: yield* sql`SELECT revision, block_count, block_bytes FROM spaces_pages WHERE page_id = ${page.id}`,
              attempted:
                yield* sql`SELECT mutation_id FROM spaces_receipts WHERE mutation_id = ${input.mutationId}`,
            };
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
          const before = yield* inspect;
          const outcome: Effect.Effect<unknown, C.SpaceServiceError> =
            method === "mutation"
              ? service.createSpace(input)
              : service.lookupMutationReceipt({ request });
          const failure = yield* outcome.pipe(
            Effect.match({ onFailure: (error) => error, onSuccess: () => null }),
          );
          assert.isNotNull(failure);
          if (failure === null) return;
          assert.equal(failure._tag, "SpaceLimitExceededError");
          if (failure._tag === "SpaceLimitExceededError") {
            const requestLimit = method === "mutation" && size === 500_000;
            assert.equal(failure.limit, requestLimit ? "maxMutationBytes" : "maxIdBytes");
            assert.equal(failure.actual, requestLimit ? bytes(request) : bytes(input.receiptEpoch));
            assert.equal(failure.maximum, requestLimit ? 262_144 : 128);
          }
          const serialized = yield* encodeServiceErrorJson(failure);
          assert.isBelow(Buffer.byteLength(serialized, "utf8"), 256);
          assert.notInclude(serialized, input.receiptEpoch);
          assert.deepEqual(yield* inspect, before);
          assert.deepEqual(before.attempted, []);
        }),
      ),
  );
});
