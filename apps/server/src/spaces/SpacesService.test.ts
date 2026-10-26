import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId } from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import * as NodeSqliteClient from "@t2code/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Settings from "../serverSettings.ts";
import * as SpacesService from "./SpacesService.ts";

const environmentId = EnvironmentId.make("test-environment");
const env = { environmentId };
const identity = Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
  getEnvironmentId: Effect.succeed(environmentId),
});
const block = (id: string, n = 1, parentId: C.SpaceBlockId | null = null): C.SpaceBlock => ({
  id: C.SpaceBlockId.make(id),
  parentId,
  order: n.toString(16).padStart(32, "0"),
  type: "paragraph",
  version: 1,
  content: { runs: [{ text: id, marks: [] }] },
});
const encodeServiceErrorJson = Schema.encodeEffect(Schema.fromJsonString(C.SpaceServiceError));
const encodeBlockJson = Schema.encodeEffect(Schema.fromJsonString(C.SpaceBlock));
const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

const fixture = Effect.fn("SpacesServiceTest.fixture")(function* <A, E>(
  use: (
    dbPath: string,
  ) => Effect.Effect<
    A,
    E,
    SpacesService.SpacesService | Settings.ServerSettingsService | FileSystem.FileSystem
  >,
  enabled = true,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "spaces-service-" });
  const dbPath = path.join(directory, "spaces.sqlite");
  return yield* use(dbPath).pipe(
    Effect.provide(
      SpacesService.layerFromPath(dbPath).pipe(
        Layer.provide(identity),
        Layer.provideMerge(Settings.layerTest({ spacesEnabled: enabled })),
      ),
    ),
  );
});
const boot = Effect.fn("SpacesServiceTest.boot")(function* () {
  const service = yield* SpacesService.SpacesService;
  const library = yield* service.listSpaces(env);
  const common = { ...env, receiptEpoch: library.mutationAdmission.epoch };
  const page = yield* service.createPage({
    ...common,
    mutationId: "page",
    spaceId: library.defaultSpaceId,
    baseRootOrderRevision: 0,
    title: "Page",
  });
  assert.equal(page.status, "saved");
  if (page.status !== "saved") return yield* Effect.die("Expected saved page");
  const request = (
    mutationId: string,
    baseRevision: number,
    mutations: readonly C.SpaceBlockMutation[],
    generation = 0,
  ): C.SpaceApplyBlockBatchInput => ({
    ...common,
    mutationId: C.SpaceMutationId.make(mutationId),
    pageId: page.page.id,
    baseRevision,
    generation,
    mutations,
  });
  return { service, library, common, page: page.page, request };
});

it.layer(NodeServices.layer)("Spaces core service", (it) => {
  it.effect(
    "never opens disabled storage, gates every operation, and retains data over disable/re-enable",
    () =>
      fixture(
        (dbPath) =>
          Effect.gen(function* () {
            const service = yield* SpacesService.SpacesService;
            const settings = yield* Settings.ServerSettingsService;
            const fs = yield* FileSystem.FileSystem;
            assert.isNull(yield* service.getCapability(environmentId));
            const operations: ReadonlyArray<
              (raw: unknown) => Effect.Effect<unknown, C.SpaceServiceError>
            > = [
              service.listSpaces,
              service.listPages,
              service.getPage,
              service.readBlocks,
              service.createSpace,
              service.renameSpace,
              service.setDefaultSpace,
              service.createPage,
              service.updatePage,
              service.applyBlockBatch,
              service.lookupMutationReceipt,
            ];
            for (const operation of operations) {
              assert.equal(
                yield* operation({}).pipe(
                  Effect.match({
                    onFailure: (error) => error._tag,
                    onSuccess: () => "unexpected success",
                  }),
                ),
                "SpacesDisabledError",
              );
            }
            assert.isFalse(yield* fs.exists(dbPath));
            yield* settings.updateSettings({ spacesEnabled: true });
            assert.equal(
              (yield* Effect.flip(service.listSpaces({ environmentId: "another" })))._tag,
              "SpaceEnvironmentMismatchError",
            );
            assert.isFalse(yield* fs.exists(dbPath));
            const library = yield* service.listSpaces(env);
            const saved = yield* service.createSpace({
              ...env,
              receiptEpoch: library.mutationAdmission.epoch,
              mutationId: "create",
              title: "Retained",
            });
            yield* settings.updateSettings({ spacesEnabled: false });
            assert.isNull(yield* service.getCapability(environmentId));
            assert.equal((yield* Effect.flip(service.listSpaces(env)))._tag, "SpacesDisabledError");
            yield* settings.updateSettings({ spacesEnabled: true });
            const again = yield* service.listSpaces(env);
            assert.isTrue(
              again.items.some(
                (space) => space.id === saved.space.id && space.title === "Retained",
              ),
            );
            assert.equal((yield* service.getCapability(environmentId))?.version, 1);
            assert.isTrue(Option.isNone(yield* Effect.serviceOption(SqlClient.SqlClient)));
          }),
        false,
      ),
  );

  it.effect("initialization failure is typed and leaves disabled startup usable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "spaces-unavailable-" });
      const obstacle = path.join(directory, "file");
      yield* fs.writeFileString(obstacle, "not a directory");
      yield* Effect.gen(function* () {
        const service = yield* SpacesService.SpacesService;
        const settings = yield* Settings.ServerSettingsService;
        assert.isNull(yield* service.getCapability(environmentId));
        yield* settings.updateSettings({ spacesEnabled: true });
        assert.isNull(yield* service.getCapability(environmentId));
        const failure = yield* Effect.flip(service.listSpaces(env));
        assert.equal(failure._tag, "SpacesUnavailableError");
        if (failure._tag === "SpacesUnavailableError") assert.equal(failure.stage, "initializing");
        yield* settings.updateSettings({ spacesEnabled: false });
        assert.equal((yield* Effect.flip(service.listSpaces(env)))._tag, "SpacesDisabledError");
      }).pipe(
        Effect.provide(
          SpacesService.layerFromPath(path.join(obstacle, "spaces.sqlite")).pipe(
            Layer.provide(identity),
            Layer.provideMerge(Settings.layerTest()),
          ),
        ),
      );
      assert.equal(yield* fs.readFileString(obstacle), "not a directory");
    }),
  );

  it.effect(
    "serializes first acquisition and commits a single guarded winner with a durable conflict",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const service = yield* SpacesService.SpacesService;
          const libraries = yield* Effect.all([service.listSpaces(env), service.listSpaces(env)], {
            concurrency: "unbounded",
          });
          assert.deepEqual(libraries[0], libraries[1]);
          const { request, page } = yield* boot();
          const a = request("a", 0, [{ kind: "insert", block: block("a") }], 3);
          const b = request("b", 0, [{ kind: "insert", block: block("b") }], 4);
          const outcomes = yield* Effect.all(
            [service.applyBlockBatch(a), service.applyBlockBatch(b)],
            { concurrency: "unbounded" },
          );
          assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), ["conflict", "saved"]);
          const loser = outcomes[0].status === "conflict" ? a : b;
          const conflict = outcomes.find((outcome) => outcome.status === "conflict")!;
          assert.equal(conflict.revision, 1);
          if (conflict.status === "conflict") assert.equal(conflict.current.pages[0]?.revision, 1);
          const window = yield* service.readBlocks({ ...env, pageId: page.id, revision: 1 });
          assert.equal(window.blocks.length, 1);
          const found = yield* service.lookupMutationReceipt({
            request: { operation: "applyBlockBatch", input: loser },
          });
          assert.deepEqual(found, {
            status: "found",
            receipt: { operation: "applyBlockBatch", result: conflict },
          });
          assert.deepEqual(yield* service.applyBlockBatch(loser), conflict);
        }),
      ),
  );

  it.effect(
    "replays exact receipts after revisions and expiry, rejects mismatched intent and never executes an expired absence",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const { service, request, common, page } = yield* boot();
          const first = request("save", 0, [{ kind: "insert", block: block("a") }], 7);
          const saved = yield* service.applyBlockBatch(first);
          yield* service.updatePage({
            ...common,
            pageId: page.id,
            mutationId: "rename",
            baseRevision: 1,
            title: "New",
          });
          const missing = { ...first, mutationId: "never-submitted" };
          assert.deepEqual(
            yield* service.lookupMutationReceipt({
              request: { operation: "applyBlockBatch", input: missing },
            }),
            { status: "absent" },
          );
          for (const changed of [
            { ...first, generation: 8 },
            { ...first, receiptEpoch: "other" },
            { ...first, mutations: [{ kind: "insert", block: { ...block("a"), opaque: 1 } }] },
          ]) {
            assert.equal(
              (yield* Effect.flip(service.applyBlockBatch(changed)))._tag,
              "SpaceMutationIdMismatchError",
            );
          }
          assert.equal(
            (yield* Effect.flip(
              service.createSpace({ ...common, mutationId: "save", title: "different operation" }),
            ))._tag,
            "SpaceMutationIdMismatchError",
          );
          yield* TestClock.adjust("2 days");
          assert.deepEqual(yield* service.applyBlockBatch(first), saved);
          assert.deepEqual(
            yield* service.lookupMutationReceipt({
              request: { operation: "applyBlockBatch", input: missing },
            }),
            { status: "unknown" },
          );
          assert.equal(
            (yield* Effect.flip(service.applyBlockBatch(missing)))._tag,
            "SpaceMutationAdmissionError",
          );
          yield* TestClock.setTime(0);
          assert.equal(
            (yield* Effect.flip(service.applyBlockBatch(missing)))._tag,
            "SpaceMutationAdmissionError",
          );
          yield* TestClock.adjust("10 days");
          // Known receipts replay even past retention until a bounded issuance pass actually removes them.
          assert.deepEqual(yield* service.applyBlockBatch(first), saved);
          const current = yield* service.listSpaces(env);
          assert.notEqual(current.mutationAdmission.epoch, first.receiptEpoch);
          assert.deepEqual(
            yield* service.lookupMutationReceipt({
              request: { operation: "applyBlockBatch", input: first },
            }),
            { status: "unknown" },
          );
          assert.equal(
            (yield* Effect.flip(service.applyBlockBatch(first)))._tag,
            "SpaceMutationAdmissionError",
          );
          assert.equal((yield* service.getPage({ ...env, pageId: page.id })).page.revision, 2);
        }),
      ),
  );

  it.effect(
    "rejects excess properties on original raw requests and the fixed raw ceiling before stripping or fingerprinting",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const { service, request } = yield* boot();
          const valid = request("strict", 0, [{ kind: "insert", block: block("a") }]);
          for (const raw of [
            { ...valid, extra: true },
            { ...valid, mutations: [{ ...valid.mutations[0], extra: true }] },
          ]) {
            assert.equal(
              (yield* Effect.flip(service.applyBlockBatch(raw)))._tag,
              "SpaceValidationError",
            );
          }
          const huge = { ...valid, extra: "x".repeat(1_048_576) };
          const error = yield* Effect.flip(service.applyBlockBatch(huge));
          assert.equal(error._tag, "SpaceLimitExceededError");
          if (error._tag === "SpaceLimitExceededError") assert.equal(error.maximum, 1_048_576);
          const lookup = { request: { operation: "applyBlockBatch", input: valid }, extra: true };
          assert.equal(
            (yield* Effect.flip(service.lookupMutationReceipt(lookup)))._tag,
            "SpaceValidationError",
          );
          assert.deepEqual(
            yield* service.lookupMutationReceipt({
              request: { operation: "applyBlockBatch", input: valid },
            }),
            { status: "absent" },
          );
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
    "validates the final graph, preserves unloaded children, and retains stable merge tombstones",
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
              readonly payload: string;
            }>`SELECT merged_into, payload FROM spaces_blocks WHERE block_id = 'child'`;
            assert.equal(tombstone?.merged_into, other.id);
            assert.deepEqual(parseJson(tombstone!.payload), {
              id: child.id,
              pageId: page.id,
              mergedInto: other.id,
            });
            const [counters] = yield* sql<{
              readonly block_count: number;
              readonly block_bytes: number;
            }>`SELECT block_count, block_bytes FROM spaces_pages WHERE page_id = ${page.id}`;
            const rows = yield* sql<{
              readonly payload: string;
            }>`SELECT payload FROM spaces_blocks WHERE page_id = ${page.id}`;
            assert.equal(counters?.block_count, 3);
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
            { ...block("unsupported"), type: "image", content: { assetId: "asset" } },
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
    "keeps admitted writes alive across disable and owns lazy storage until the layer closes",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "spaces-admission-" });
        const dbPath = path.join(directory, "spaces.sqlite");
        const accepted = yield* Deferred.make<void>();
        const proceed = yield* Deferred.make<void>();
        const settingsContext = yield* Layer.build(Settings.layerTest({ spacesEnabled: true }));
        const settings = Context.get(settingsContext, Settings.ServerSettingsService);
        const pauseIdentity = yield* Ref.make(false);
        const waitIdentity = Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Ref.get(pauseIdentity).pipe(
            Effect.flatMap((pause) =>
              pause
                ? Deferred.succeed(accepted, undefined).pipe(
                    Effect.andThen(Deferred.await(proceed)),
                    Effect.as(environmentId),
                  )
                : Effect.succeed(environmentId),
            ),
          ),
        });
        yield* Effect.gen(function* () {
          const service = yield* SpacesService.SpacesService;
          const library = yield* service.listSpaces(env);
          yield* Ref.set(pauseIdentity, true);
          const fiber = yield* service
            .createSpace({
              ...env,
              receiptEpoch: library.mutationAdmission.epoch,
              mutationId: "accepted",
              title: "Accepted before disable",
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(accepted);
          yield* settings.updateSettings({ spacesEnabled: false });
          yield* Deferred.succeed(proceed, undefined);
          const saved = yield* Fiber.join(fiber);
          assert.equal(saved.space.title, "Accepted before disable");
          assert.equal((yield* Effect.flip(service.listSpaces(env)))._tag, "SpacesDisabledError");
        }).pipe(
          Effect.provide(
            SpacesService.layerFromPath(dbPath).pipe(
              Layer.provide(waitIdentity),
              Layer.provide(Layer.succeedContext(settingsContext)),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const service = yield* SpacesService.SpacesService;
          const library = yield* service.listSpaces(env);
          assert.isTrue(library.items.some((space) => space.title === "Accepted before disable"));
        }).pipe(
          Effect.provide(
            SpacesService.layerFromPath(dbPath).pipe(
              Layer.provide(identity),
              Layer.provide(Settings.layerTest({ spacesEnabled: true })),
            ),
          ),
        );
      }),
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

  it.effect(
    "bounds raw decoding before the current policy and accounts for JSON escaping in IDs",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const { service, request, common, page } = yield* boot();
          const base = { ...common, mutationId: "protocol", title: "" };
          const room = 1_048_576 - bytes({ operation: "createSpace", input: base });
          const exact = { ...base, title: "x".repeat(room) };
          const error = yield* Effect.flip(service.createSpace(exact));
          assert.equal(error._tag, "SpaceLimitExceededError");
          if (error._tag === "SpaceLimitExceededError") assert.equal(error.maximum, 262_144);
          const over = yield* Effect.flip(
            service.createSpace({ ...exact, title: exact.title + "x" }),
          );
          assert.equal(over._tag, "SpaceLimitExceededError");
          if (over._tag === "SpaceLimitExceededError") assert.equal(over.maximum, 1_048_576);
          const id = "界".repeat(42);
          assert.equal(bytes(id), 128);
          const allowed = { ...block(id), content: { runs: [{ text: '\n"', marks: [] }] } };
          yield* service.applyBlockBatch(
            request("id-exact", 0, [{ kind: "insert", block: allowed }]),
          );
          const rejected = request("id-over", 1, [{ kind: "insert", block: block(id + "x") }]);
          assert.equal(
            (yield* Effect.flip(service.applyBlockBatch(rejected)))._tag,
            "SpaceLimitExceededError",
          );
          assert.deepEqual(
            (yield* service.readBlocks({ ...env, pageId: page.id, revision: 1 })).blocks,
            [allowed],
          );
        }),
      ),
  );

  it.effect(
    "commits identical concurrent intent once and accounts for persisted receipts independently",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, common, library } = yield* boot();
          const input = { ...common, mutationId: "same", title: "界" };
          const results = yield* Effect.all(
            [service.createSpace(input), service.createSpace(input)],
            { concurrency: "unbounded" },
          );
          assert.deepEqual(results[0], results[1]);
          assert.equal((yield* service.listSpaces(env)).items.length, 2);
          const noOp = yield* service.setDefaultSpace({
            ...common,
            mutationId: "no-op",
            spaceId: library.defaultSpaceId,
            defaultSpaceId: library.defaultSpaceId,
            baseRevision: 0,
            baseDefaultRevision: 0,
          });
          assert.equal(noOp.status, "saved");
          assert.equal((yield* service.listSpaces(env)).catalogRevision, 2);
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const [meta] = yield* sql<{
              readonly receipt_rows: number;
              readonly receipt_bytes: number;
            }>`SELECT receipt_rows, receipt_bytes FROM spaces_core`;
            const rows = yield* sql<{
              readonly mutation_id: string;
              readonly fingerprint: string;
              readonly payload: string;
              readonly epoch: string;
              readonly logical_bytes: number;
              readonly retain_until: number;
            }>`SELECT * FROM spaces_receipts`;
            assert.equal(meta?.receipt_rows, 3);
            const logical = rows.map((row) => ({
              environmentId,
              mutationId: row.mutation_id,
              receiptEpoch: row.epoch,
              fingerprint: row.fingerprint,
              createdAt: "1970-01-01T00:00:00.000Z",
              retainUntil: "1970-01-09T00:00:00.000Z",
              receipt: parseJson(row.payload),
            }));
            assert.deepEqual(
              rows.map((row) => row.logical_bytes),
              logical.map(bytes),
            );
            assert.equal(
              meta?.receipt_bytes,
              logical.reduce((total, row) => total + bytes(row), 0),
            );
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
        }),
      ),
  );
  it.effect(
    "refuses new work at receipt quota without evicting unexpired receipts and cleans only a bounded expired batch",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const service = yield* SpacesService.SpacesService;
          const library = yield* service.listSpaces(env);
          const common = { ...env, receiptEpoch: library.mutationAdmission.epoch };
          const input = {
            ...common,
            mutationId: "receipt-00000",
            spaceId: library.defaultSpaceId,
            baseRevision: 0,
            title: library.items[0]!.title,
          };
          const first = yield* service.renameSpace(input);
          for (let i = 1; i < 10_000; i++)
            yield* service.renameSpace({
              ...input,
              mutationId: `receipt-${String(i).padStart(5, "0")}`,
            });
          const rejected = { ...common, mutationId: "over-capacity", title: "Must roll back" };
          const error = yield* Effect.flip(service.createSpace(rejected));
          assert.equal(error._tag, "SpaceLimitExceededError");
          if (error._tag === "SpaceLimitExceededError") assert.equal(error.limit, "maxReceiptRows");
          assert.deepEqual(yield* service.renameSpace(input), first);
          assert.deepEqual(
            yield* service.lookupMutationReceipt({
              request: { operation: "createSpace", input: rejected },
            }),
            { status: "absent" },
          );
          const before = yield* service.listSpaces(env);
          assert.equal(before.items.length, 1);
          assert.equal(before.catalogRevision, 0);
          const inspect = Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const [row] = yield* sql<{
              readonly count: number;
              readonly actual: number;
            }>`SELECT receipt_rows AS count, (SELECT COUNT(*) FROM spaces_receipts) AS actual FROM spaces_core`;
            return row;
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
          assert.deepEqual(yield* inspect, { count: 10_000, actual: 10_000 });
          yield* TestClock.adjust("8 days");
          const rotated = yield* service.listSpaces(env);
          assert.notEqual(rotated.mutationAdmission.epoch, common.receiptEpoch);
          assert.deepEqual(yield* inspect, { count: 9_900, actual: 9_900 });
          assert.deepEqual(
            yield* service.lookupMutationReceipt({ request: { operation: "renameSpace", input } }),
            { status: "unknown" },
          );
          const retained = { ...input, mutationId: "receipt-09999" };
          assert.equal((yield* service.renameSpace(retained)).status, "saved");
          assert.equal(
            (yield* Effect.flip(service.renameSpace(input)))._tag,
            "SpaceMutationAdmissionError",
          );
          yield* service.createSpace({
            ...rejected,
            receiptEpoch: rotated.mutationAdmission.epoch,
          });
          assert.deepEqual(yield* inspect, { count: 9_901, actual: 9_901 });
        }),
      ),
  );

  it.effect(
    "enforces final page bytes atomically, including retained tombstones, without transient-order rejection",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const { service, request, page } = yield* boot();
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
          assert.equal(
            (yield* service.getPage({ ...env, pageId: page.id })).page.revision,
            revision,
          );
          assert.deepEqual(
            yield* service.lookupMutationReceipt({
              request: { operation: "applyBlockBatch", input: over },
            }),
            { status: "absent" },
          );
          const old = values[0]!;
          const tombstoneBytes = bytes({ id: old.id, pageId: page.id, mergedInto: null });
          const base = { ...block("extra"), type: "code", content: { language: "", text: "" } };
          const replacement = {
            ...base,
            content: { language: "", text: "x".repeat(32_768 - tombstoneBytes - bytes(base)) },
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
        }),
      ),
  );

  it.effect(
    "charges stable tombstones against the page block cap and rolls back an over-cap insert",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const { service, request, page } = yield* boot();
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
          const over = request("page-count-over", 101, [
            { kind: "insert", block: block("one-too-many") },
          ]);
          const error = yield* Effect.flip(service.applyBlockBatch(over));
          assert.equal(error._tag, "SpaceLimitExceededError");
          if (error._tag === "SpaceLimitExceededError") {
            assert.equal(error.limit, "maxPageBlocks");
            assert.equal(error.actual, 10_001);
          }
          assert.equal((yield* service.getPage({ ...env, pageId: page.id })).page.revision, 101);
          assert.deepEqual(
            yield* service.lookupMutationReceipt({
              request: { operation: "applyBlockBatch", input: over },
            }),
            { status: "absent" },
          );
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
