import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- independently verify the capture hash with platform SHA-256.
import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";
import { serializeSpaceContextSnapshotForHash } from "@t2code/shared/composerContextReferences";
import * as C from "@t2code/contracts/spaces";
import * as NodeSqliteClient from "@t2code/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Settings from "../../serverSettings.ts";
import {
  isPageContext,
  isBlockContext,
  env,
  block,
  bytes,
  fixture,
  boot,
  childPage,
  rootPage,
  blockMoveIntent,
} from "./Spaces.testkit.ts";

it.layer(NodeServices.layer)("Spaces core service", (it) => {
  it.effect("rejects oversized capture payloads using only index and record-header metadata", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { service, page, request } = yield* boot();
        yield* service.applyBlockBatch(
          request("overflow-seed", 0, [{ kind: "insert", block: block("overflow") }]),
        );
        const payload = JSON.stringify({
          ...block("overflow"),
          type: "future-block",
          version: 3,
          content: { opaque: "x".repeat(4 * 1024 * 1024) },
        });
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const [old] = yield* sql<{
            logical_bytes: number;
          }>`SELECT logical_bytes FROM spaces_blocks WHERE block_id='overflow'`;
          yield* sql`UPDATE spaces_blocks SET payload=${payload},logical_bytes=${Buffer.byteLength(payload, "utf8")} WHERE block_id='overflow'`;
          yield* sql`UPDATE spaces_pages SET block_bytes=block_bytes+${Buffer.byteLength(payload, "utf8") - old!.logical_bytes} WHERE page_id=${page.id}`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
        const statements: string[] = [];
        const tracer = Tracer.make({
          span(options) {
            const span = new Tracer.NativeSpan(options);
            const end = span.end.bind(span);
            span.end = (time, exit) => {
              end(time, exit);
              const parent = Option.getOrUndefined(span.parent);
              const query = span.attributes.get("db.query.text");
              if (
                parent?._tag === "Span" &&
                parent.name === "SpacesContextSnapshot.capture" &&
                typeof query === "string"
              )
                statements.push(query);
            };
            return span;
          },
        });
        const captured = yield* service
          .captureContextSnapshot({
            ...env,
            contextId: "ctx",
            target: { kind: "page", pageId: page.id },
          })
          .pipe(Effect.withTracer(tracer));
        if (captured.status !== "captured") return yield* Effect.die("Expected capture");
        assert.isTrue(captured.record.snapshot.truncated);
        assert.deepEqual(captured.record.snapshot.sources[0]?.blockIds, []);
        assert.isNotEmpty(statements);
        const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
        try {
          const payloadColumn = Number(
            db
              .prepare("PRAGMA table_info(spaces_blocks)")
              .all()
              .find((column) => column.name === "payload")!.cid,
          );
          const tableRoot = Number(
            db
              .prepare(
                "SELECT rootpage FROM sqlite_schema WHERE type='table' AND name='spaces_blocks'",
              )
              .get()!.rootpage,
          );
          for (const query of statements) {
            const ops = db.prepare(`EXPLAIN ${query}`).all();
            const tableCursors = new Set(
              ops
                .filter((op) => op.opcode === "OpenRead" && Number(op.p2) === tableRoot)
                .map((op) => Number(op.p1)),
            );
            for (const op of ops.filter(
              (op) => op.opcode === "Column" && tableCursors.has(Number(op.p1)),
            )) {
              assert.isAtMost(Number(op.p2), payloadColumn);
              if (Number(op.p2) === payloadColumn) {
                // SQLite marks byte-length argument reads as metadata-only (0xc0).
                assert.equal(Number(op.p5) & 0xc0, 0xc0);
              }
            }
          }
        } finally {
          db.close();
        }
      }),
    ),
  );

  it.effect("captures context snapshots with child opt-in and moved merged block identity", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service, page, common, request } = yield* boot();
        const survivor = block("survivor", 1);
        const retired = block("retired", 2);
        yield* service.applyBlockBatch(
          request(
            "capture-identities",
            0,
            [survivor, retired].map((value) => ({ kind: "insert", block: value })),
          ),
        );
        const child = yield* childPage(service, common, page.id, "capture-child");
        yield* service.applyBlockBatch({
          ...request("child-body", 0, [{ kind: "insert", block: block("private-child-text") }]),
          pageId: child.page.id,
        });
        const input = { ...env, contextId: "ctx", target: { kind: "page", pageId: page.id } };
        const own = yield* service.captureContextSnapshot(input);
        const deep = yield* service.captureContextSnapshot({ ...input, includeChildPages: true });
        if (own.status !== "captured" || deep.status !== "captured")
          return yield* Effect.die("Expected captures");
        assert.lengthOf(own.record.snapshot.sources, 1);
        assert.notInclude(own.record.snapshot.text, "private-child-text");
        assert.include(deep.record.snapshot.text, "private-child-text");
        assert.deepEqual(
          deep.record.snapshot.sources.map((source) => [source.pageId, source.revision]),
          [
            [page.id, 2],
            [child.page.id, 1],
          ],
        );
        yield* service.applyBlockBatch(
          request("capture-merge", 2, [
            { kind: "delete", blockId: retired.id, mergedInto: survivor.id },
          ]),
        );
        const destination = yield* rootPage(service, common, page.spaceId, "capture-destination");
        const intent = yield* blockMoveIntent(
          service,
          common,
          page.id,
          [survivor.id],
          { pageId: destination.id, parentId: null, beforeBlockId: null },
          "capture-move",
        );
        yield* service.moveBlocks(intent);
        const moved = yield* service.captureContextSnapshot({
          ...env,
          contextId: "merged",
          target: { kind: "block", blockId: retired.id },
        });
        if (moved.status !== "captured" || moved.record.kind !== "block")
          return yield* Effect.die("Expected merged capture");
        assert.equal(moved.record.pageId, destination.id);
        assert.equal(moved.record.blockId, retired.id);
        assert.equal(moved.record.resolvedBlockId, survivor.id);
        assert.deepEqual(moved.record.snapshot.sources[0]?.blockIds, [survivor.id]);
        assert.equal(moved.record.snapshot.sources[0]?.revision, 1);
      }),
    ),
  );

  it.effect(
    "bounds context snapshots at eight source pages and combined traversal depth sixteen",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const { service, page, common, request } = yield* boot();
          let parent = page.id;
          for (let i = 0; i < 7; i++)
            parent = (yield* childPage(service, common, parent, `snapshot-child-${i}`)).page.id;
          const input = {
            ...env,
            contextId: "ctx",
            target: { kind: "page", pageId: page.id },
            includeChildPages: true,
          };
          const exact = yield* service.captureContextSnapshot(input);
          if (exact.status !== "captured") return yield* Effect.die("Expected capture");
          assert.lengthOf(exact.record.snapshot.sources, 8);
          assert.isFalse(exact.record.snapshot.truncated);
          const ninth = yield* childPage(service, common, parent, "snapshot-ninth");
          const over = yield* service.captureContextSnapshot(input);
          if (over.status !== "captured") return yield* Effect.die("Expected capture");
          assert.lengthOf(over.record.snapshot.sources, 8);
          assert.isFalse(
            over.record.snapshot.sources.some((source) => source.pageId === ninth.page.id),
          );
          assert.isTrue(over.record.snapshot.truncated);
          const depthPage = yield* rootPage(service, common, page.spaceId, "depth-page");
          const lists = Array.from({ length: 15 }, (_, i) => ({
            ...block(`depth-${i}`, 1, i === 0 ? null : C.SpaceBlockId.make(`depth-${i - 1}`)),
            type: "bulleted_item",
          }));
          yield* service.applyBlockBatch({
            ...request(
              "depth-seed",
              0,
              lists.map((value) => ({ kind: "insert", block: value })),
            ),
            pageId: depthPage.id,
          });
          const depthChild = yield* childPage(
            service,
            common,
            depthPage.id,
            "depth-child",
            null,
            lists[14]!.id,
          );
          yield* service.applyBlockBatch({
            ...request("depth-child-body", 0, [
              { kind: "insert", block: block("depth-seventeen") },
            ]),
            pageId: depthChild.page.id,
          });
          const depth = yield* service.captureContextSnapshot({
            ...input,
            target: { kind: "page", pageId: depthPage.id },
          });
          if (depth.status !== "captured") return yield* Effect.die("Expected capture");
          assert.isTrue(depth.record.snapshot.truncated);
          assert.notInclude(depth.record.snapshot.text, "depth-seventeen");
          assert.equal(
            depth.record.snapshot.sources.reduce((n, source) => n + source.blockIds.length, 0),
            16,
          );
          const atDepth = yield* service.captureContextSnapshot({
            ...input,
            target: { kind: "page", pageId: depthPage.id },
            includeChildPages: false,
          });
          if (atDepth.status !== "captured") return yield* Effect.die("Expected capture");
          assert.isFalse(atDepth.record.snapshot.truncated);
        }),
      ),
  );

  it.effect(
    "bounds context snapshots at one hundred included identities and two MiB inspected bytes",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const { service, page, common, request } = yield* boot();
          const values = Array.from({ length: 100 }, (_, i) => block(`bounded-${i}`, i + 1));
          yield* service.applyBlockBatch(
            request(
              "hundred",
              0,
              values.map((value) => ({ kind: "insert", block: value })),
            ),
          );
          const input = { ...env, contextId: "ctx", target: { kind: "page", pageId: page.id } };
          const exact = yield* service.captureContextSnapshot(input);
          if (exact.status !== "captured") return yield* Effect.die("Expected capture");
          assert.lengthOf(exact.record.snapshot.sources[0]!.blockIds, 100);
          assert.isFalse(exact.record.snapshot.truncated);
          yield* service.applyBlockBatch(
            request("hundred-one", 1, [{ kind: "insert", block: block("beyond-hundred", 101) }]),
          );
          const over = yield* service.captureContextSnapshot(input);
          if (over.status !== "captured") return yield* Effect.die("Expected capture");
          assert.lengthOf(over.record.snapshot.sources[0]!.blockIds, 100);
          assert.isTrue(over.record.snapshot.truncated);
          assert.notInclude(over.record.snapshot.text, "beyond-hundred");
          const bytePage = yield* rootPage(service, common, page.spaceId, "byte-budget");
          const padded = Array.from({ length: 65 }, (_, i) => {
            const value = { ...block(`padded-${i}`, i + 1), padding: "" };
            value.padding = "x".repeat(32_768 - bytes(value));
            return value;
          });
          let revision = 0;
          for (let i = 0; i < 64; i += 7) {
            const ack = yield* service.applyBlockBatch({
              ...request(
                `pad-${i}`,
                revision,
                padded
                  .slice(i, Math.min(i + 7, 64))
                  .map((value) => ({ kind: "insert", block: value })),
              ),
              pageId: bytePage.id,
            });
            if (ack.status !== "saved") return yield* Effect.die("Expected saved blocks");
            revision = ack.revision;
          }
          const byteInput = { ...input, target: { kind: "page", pageId: bytePage.id } };
          const fullBytes = yield* service.captureContextSnapshot(byteInput);
          if (fullBytes.status !== "captured") return yield* Effect.die("Expected capture");
          assert.isFalse(fullBytes.record.snapshot.truncated);
          assert.lengthOf(fullBytes.record.snapshot.sources[0]!.blockIds, 64);
          yield* service.applyBlockBatch({
            ...request("pad-over", revision, [{ kind: "insert", block: padded[64]! }]),
            pageId: bytePage.id,
          });
          const clippedBytes = yield* service.captureContextSnapshot(byteInput);
          if (clippedBytes.status !== "captured") return yield* Effect.die("Expected capture");
          assert.isTrue(clippedBytes.record.snapshot.truncated);
          assert.lengthOf(clippedBytes.record.snapshot.sources[0]!.blockIds, 64);
          assert.notInclude(clippedBytes.record.snapshot.text, "padded-64");
          assert.notInclude(clippedBytes.record.snapshot.text, "x".repeat(100));
        }),
      ),
  );

  it.effect(
    "clips context snapshots on code points including marker and serialized record budgets",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const { service, page, request } = yield* boot();
          const input = { ...env, contextId: "ctx", target: { kind: "page", pageId: page.id } };
          let revision = 0;
          const contents = [
            "x".repeat(16_000),
            "x".repeat(16_001),
            "😀".repeat(8_001),
            "界".repeat(5_000),
            "\0".repeat(4_000),
          ];
          for (let i = 0; i < contents.length; i++) {
            const value = {
              ...block("clip"),
              content: { runs: [{ text: contents[i]!, marks: [] }] },
            };
            yield* service.applyBlockBatch(
              request(`text-${i}`, revision++, [
                { kind: i === 0 ? "insert" : "replace", block: value },
              ]),
            );
            const captured = yield* service.captureContextSnapshot(input);
            if (captured.status !== "captured") return yield* Effect.die("Expected capture");
            assert.isTrue(isPageContext(captured.record));
            assert.isTrue(captured.record.snapshot.text.isWellFormed());
            assert.isAtMost(captured.record.snapshot.text.length, 16_000);
            assert.isAtMost(Buffer.byteLength(captured.record.snapshot.text, "utf8"), 32_768);
            assert.isAtMost(bytes(captured.record), 65_536);
            assert.equal(captured.record.snapshot.truncated, i === 1 || i === 2);
            if (captured.record.snapshot.truncated)
              assert.isTrue(captured.record.snapshot.text.endsWith("\n… truncated …"));
          }
          yield* service.applyBlockBatch(
            request(
              "escaped-body",
              revision++,
              [block("two", 2), block("three", 3)].map((value) => ({
                kind: "insert",
                block: { ...value, content: { runs: [{ text: "\0".repeat(4_000), marks: [] }] } },
              })),
            ),
          );
          const sizes: number[] = [];
          for (let i = 1; i <= 6; i++) {
            const result = yield* service.captureContextSnapshot({
              ...input,
              contextId: "c".repeat(i),
            });
            if (result.status !== "captured") return yield* Effect.die("Expected capture");
            sizes.push(bytes(result.record));
            assert.isTrue(isPageContext(result.record));
            assert.isTrue(result.record.snapshot.truncated);
          }
          assert.equal(Math.max(...sizes), 65_536);
          const utf = ["界".repeat(5_000), "界".repeat(5_922) + "x"];
          yield* service.applyBlockBatch(
            request("utf8-exact", revision++, [
              {
                kind: "replace",
                block: { ...block("clip"), content: { runs: [{ text: utf[0]!, marks: [] }] } },
              },
              {
                kind: "replace",
                block: { ...block("two", 2), content: { runs: [{ text: utf[1]!, marks: [] }] } },
              },
              { kind: "delete", blockId: C.SpaceBlockId.make("three") },
            ]),
          );
          const exact = yield* service.captureContextSnapshot(input);
          if (exact.status !== "captured") return yield* Effect.die("Expected capture");
          assert.equal(Buffer.byteLength(exact.record.snapshot.text, "utf8"), 32_768);
          assert.isFalse(exact.record.snapshot.truncated);
          yield* service.applyBlockBatch(
            request("utf8-over", revision, [
              {
                kind: "replace",
                block: {
                  ...block("two", 2),
                  content: { runs: [{ text: utf[1]! + "x", marks: [] }] },
                },
              },
            ]),
          );
          const over = yield* service.captureContextSnapshot(input);
          if (over.status !== "captured") return yield* Effect.die("Expected capture");
          assert.isTrue(over.record.snapshot.truncated);
          assert.isAtMost(Buffer.byteLength(over.record.snapshot.text, "utf8"), 32_768);
        }),
      ),
  );

  it.effect(
    "captures context snapshots with legacy media captions and opaque block placeholders",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, page, request } = yield* boot();
          const original = [block("media", 1), block("future", 2)];
          yield* service.applyBlockBatch(
            request(
              "legacy-capture",
              0,
              original.map((value) => ({ kind: "insert", block: value })),
            ),
          );
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            for (const value of [
              {
                ...original[0],
                type: "video",
                content: { assetId: "asset-id", caption: [{ text: "A caption", marks: [] }] },
                opaque: "DO NOT COPY",
              },
              {
                ...original[1],
                type: "future-widget",
                version: 7,
                content: { secret: "OPAQUE FUTURE DATA" },
              },
            ]) {
              const payload = JSON.stringify(value);
              yield* sql`UPDATE spaces_blocks SET payload=${payload},logical_bytes=${Buffer.byteLength(payload, "utf8")} WHERE block_id=${value.id}`;
            }
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
          const captured = yield* service.captureContextSnapshot({
            ...env,
            contextId: "ctx",
            target: { kind: "page", pageId: page.id },
          });
          if (captured.status !== "captured") return yield* Effect.die("Expected capture");
          assert.equal(
            captured.record.snapshot.text,
            "[video asset-id] A caption\n[Unsupported block]",
          );
        }),
      ),
  );

  it.effect("gates context snapshots by enabled state, environment and strict bounded input", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service, page, request } = yield* boot();
        const input = { ...env, contextId: "ctx", target: { kind: "page", pageId: page.id } };
        assert.equal(
          (yield* service
            .captureContextSnapshot({ ...input, environmentId: "elsewhere" })
            .pipe(Effect.flip))._tag,
          "SpaceEnvironmentMismatchError",
        );
        for (const invalid of [
          { ...input, contextId: "x".repeat(129) },
          { ...input, target: { ...input.target, revision: 999 } },
          { ...input, includeChildPages: "yes" },
        ])
          assert.equal(
            (yield* service.captureContextSnapshot(invalid).pipe(Effect.flip))._tag,
            "SpaceValidationError",
          );
        assert.deepEqual(
          yield* service.captureContextSnapshot({
            ...input,
            target: { kind: "block", blockId: "missing" },
          }),
          { status: "unavailable" },
        );
        yield* service.applyBlockBatch(
          request("delete-seed", 0, [{ kind: "insert", block: block("deleted") }]),
        );
        yield* service.applyBlockBatch(
          request("delete", 1, [{ kind: "delete", blockId: C.SpaceBlockId.make("deleted") }]),
        );
        assert.deepEqual(
          yield* service.captureContextSnapshot({
            ...input,
            target: { kind: "block", blockId: "deleted" },
          }),
          { status: "deleted" },
        );
        const settings = yield* Settings.ServerSettingsService;
        yield* settings.updateSettings({ spacesEnabled: false });
        assert.equal(
          (yield* service.captureContextSnapshot(input).pipe(Effect.flip))._tag,
          "SpacesDisabledError",
        );
      }),
    ),
  );

  it.effect("expands a synced copy once from its original page and lists the source", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service, common, page, library, request } = yield* boot();
        const host = yield* rootPage(service, common, library.defaultSpaceId, "Host");
        const synced = {
          ...block("original", 1),
          type: "synced_block",
          content: {},
        };
        yield* service.applyBlockBatch(
          request("seed-original", 0, [
            { kind: "insert", block: synced },
            { kind: "insert", block: block("source-text", 1, synced.id) },
          ]),
        );
        const ref = (id: string, sourceBlockId: string, order: number) => ({
          ...block(id, order),
          type: "synced_ref",
          content: { sourceBlockId },
        });
        yield* service.applyBlockBatch({
          ...common,
          mutationId: C.SpaceMutationId.make("seed-copies"),
          pageId: host.id,
          baseRevision: host.revision,
          generation: 0,
          mutations: [
            { kind: "insert", block: ref("copy-1", "original", 1) },
            { kind: "insert", block: ref("copy-2", "original", 2) },
            { kind: "insert", block: ref("copy-gone", "gone", 3) },
            {
              kind: "insert",
              block: { ...synced, id: "gone", order: "00000000000000000000000000000009" },
            },
          ],
        });
        yield* service.applyBlockBatch({
          ...common,
          mutationId: C.SpaceMutationId.make("drop-original"),
          pageId: host.id,
          baseRevision: host.revision + 1,
          generation: 1,
          mutations: [{ kind: "delete", blockId: C.SpaceBlockId.make("gone") }],
        });
        const captured = yield* service.captureContextSnapshot({
          ...env,
          contextId: "synced_ctx",
          target: { kind: "page", pageId: host.id },
        });
        assert.equal(captured.status, "captured");
        if (captured.status !== "captured") return;
        assert.equal(
          captured.record.snapshot.text,
          [
            "[synced from Page]",
            "source-text",
            "[synced from Page]",
            "[synced block unavailable]",
          ].join("\n"),
        );
        assert.deepEqual(
          captured.record.snapshot.sources.map((source) => source.pageId),
          [host.id, page.id],
        );
        const original = yield* service.captureContextSnapshot({
          ...env,
          contextId: "original_ctx",
          target: { kind: "page", pageId: page.id },
        });
        assert.equal(
          original.status === "captured" && original.record.snapshot.text,
          "source-text",
        );
      }),
    ),
  );

  it.effect("accepts children under a toggle and includes them in context snapshots", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service, page, request } = yield* boot();
        const toggle = { ...block("toggle", 1), type: "toggle" };
        yield* service.applyBlockBatch(
          request(
            "seed-toggle",
            0,
            [toggle, block("inside", 1, toggle.id)].map((value) => ({
              kind: "insert",
              block: value,
            })),
          ),
        );
        const captured = yield* service.captureContextSnapshot({
          ...env,
          contextId: "toggle_ctx",
          target: { kind: "page", pageId: page.id },
        });
        assert.equal(captured.status, "captured");
        if (captured.status !== "captured") return;
        assert.equal(captured.record.snapshot.text, "toggle\ninside");
      }),
    ),
  );

  it.effect(
    "captures context snapshots from deterministic page-own blocks and a selected subtree",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const { service, page, request } = yield* boot();
          const parent = { ...block("list", 2), type: "bulleted_item" };
          yield* service.applyBlockBatch(
            request(
              "seed-capture",
              0,
              [block("a", 1), parent, block("nested", 1, parent.id), block("z", 3)].map(
                (value) => ({ kind: "insert", block: value }),
              ),
            ),
          );
          const captured = yield* service.captureContextSnapshot({
            ...env,
            contextId: "page_ctx",
            target: { kind: "page", pageId: page.id },
          });
          assert.equal(captured.status, "captured");
          if (captured.status !== "captured") return;
          const record = captured.record;
          assert.isTrue(isPageContext(record));
          assert.equal(record.snapshot.text, "a\nlist\nnested\nz");
          assert.deepEqual(record.snapshot.sources, [
            {
              ...env,
              spaceId: page.spaceId,
              pageId: page.id,
              revision: 1,
              blockIds: ["a", "list", "nested", "z"].map((id) => C.SpaceBlockId.make(id)),
            },
          ]);
          assert.isFalse(record.snapshot.truncated);
          assert.equal(
            record.snapshot.contentHash,
            `sha256:${NodeCrypto.createHash("sha256")
              .update(serializeSpaceContextSnapshotForHash(record), "utf8")
              .digest("hex")}`,
          );
          const subtree = yield* service.captureContextSnapshot({
            ...env,
            contextId: "block_ctx",
            target: { kind: "block", blockId: parent.id },
          });
          assert.equal(subtree.status, "captured");
          if (subtree.status !== "captured") return;
          assert.isTrue(isBlockContext(subtree.record));
          assert.equal(subtree.record.snapshot.text, "list\nnested");
          yield* service.applyBlockBatch(
            request("mutate-after-capture", 1, [
              {
                kind: "replace",
                block: { ...block("a", 1), content: { runs: [{ text: "new", marks: [] }] } },
              },
            ]),
          );
          assert.equal(record.snapshot.text, "a\nlist\nnested\nz");
          assert.equal(record.snapshot.sources[0]?.revision, 1);
          const later = yield* service.captureContextSnapshot({
            ...env,
            contextId: "page_ctx",
            target: { kind: "page", pageId: page.id },
          });
          if (later.status !== "captured") return yield* Effect.die("Expected capture");
          assert.equal(later.record.snapshot.sources[0]?.revision, 2);
          assert.notEqual(later.record.snapshot.contentHash, record.snapshot.contentHash);
        }),
      ),
  );
});
