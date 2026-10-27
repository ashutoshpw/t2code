import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqlite from "node:sqlite";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Crypto from "effect/Crypto";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  SpaceContextCaptureResult,
} from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as Settings from "../../../serverSettings.ts";
import * as SpacesService from "../../../spaces/SpacesService.ts";
import { canonical } from "../../../spaces/CorePolicy.ts";
import { serializeSpaceContextSnapshotForHash } from "@t2code/shared/composerContextReferences";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";

const environmentId = EnvironmentId.make("spaces-mcp");
const env = { environmentId };
const threadId = ThreadId.make("spaces-caller");
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "spaces-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "spaces-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const scope: Invocation.McpInvocationScope = {
  environmentId,
  requestNamespace: "spaces-test",
  thread: undefined,
  client: { sessionId: "external", label: "external", access: "auto" },
  capabilities: new Set(["spaces"]),
  issuedAt: 0,
};
const decodeList = Schema.decodeUnknownSync(C.SpaceListResult);
const decodeCreated = Schema.decodeUnknownSync(C.SpacePageCreateResult);
const decodeApplied = Schema.decodeUnknownSync(C.SpaceApplyBlockBatchResult);
const decodeWindow = Schema.decodeUnknownSync(C.SpaceReadBlocksResult);
const decodeCapture = Schema.decodeUnknownSync(SpaceContextCaptureResult);
const decodeLookup = Schema.decodeUnknownSync(C.SpaceReceiptLookupResult);
function value(result: McpSchema.CallToolResult) {
  assert.notEqual(result.isError, true);
  const content = result.content[0];
  if (content?.type !== "text") throw Error("Expected JSON text");
  const json = JSON.parse(content.text);
  assert.deepEqual(result.structuredContent, json);
  return json;
}
function failure(result: McpSchema.CallToolResult) {
  assert.equal(result.isError, true);
  const content = result.content[0];
  if (content?.type !== "text") throw Error("Expected failure JSON");
  assert.isBelow(Buffer.byteLength(JSON.stringify(result)), 2048);
  return JSON.parse(content.text);
}
const fixture = Effect.fn("SpacesMcpTest.fixture")(function* <A, E>(
  use: (
    dbPath: string,
    stopCaller: Effect.Effect<void>,
  ) => Effect.Effect<
    A,
    E,
    | SpacesService.SpacesService
    | Settings.ServerSettingsService
    | McpServer.McpServer
    | import("effect/Scope").Scope
    | ThreadManagement.ThreadManagementService
    | Crypto.Crypto
  >,
  enabled = true,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "spaces-mcp-" });
  const dbPath = path.join(directory, "spaces.sqlite");
  const layerService = SpacesService.layerFromPath(dbPath).pipe(
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(environmentId),
      }),
    ),
    Layer.provideMerge(Settings.layerTest({ spacesEnabled: enabled })),
  );
  const caller = yield* Ref.make(liveThreadShell(threadId, { runtimeMode: "approval-required" }));
  const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: () => Ref.get(caller),
  });
  return yield* use(
    dbPath,
    Ref.update(caller, (shell) => ({ ...shell, activeRunId: null })),
  ).pipe(
    Effect.provide(
      McpHttpServer.layerSpacesToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provideMerge(layerService),
        Layer.provideMerge(threads),
      ),
    ),
  );
});
const call = Effect.fn("SpacesMcpTest.call")(function* (
  name: string,
  args: unknown,
  invocation = scope,
) {
  const server = yield* McpServer.McpServer;
  // JSON round trips exercise the registered advertised parameter codec and actual result encoding.
  return yield* server
    .callTool({ name, arguments: JSON.parse(JSON.stringify(args)) })
    .pipe(
      Effect.provideService(Invocation.McpInvocationContext, invocation),
      Effect.provideService(McpSchema.McpServerClient, client),
    );
});
it.layer(Layer.merge(NodeServices.layer, NodeCrypto.layer))("registered Spaces MCP", (it) => {
  it.effect(
    "lets a read-only client read the singleton but refuses writes without a database commit",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const readOnly = { ...scope, client: { ...scope.client!, access: "read-only" as const } };
          const library = decodeList(value(yield* call("t2_spaces_list", env, readOnly)));
          const service = yield* SpacesService.SpacesService;
          assert.equal((yield* service.listSpaces(env)).defaultSpaceId, library.defaultSpaceId);
          const observer = yield* Effect.acquireRelease(
            Effect.sync(() => new NodeSqlite.DatabaseSync(dbPath, { readOnly: true })),
            (db) => Effect.sync(() => db.close()),
          );
          const version = observer.prepare("PRAGMA data_version").get();
          const input = {
            ...env,
            receiptEpoch: library.mutationAdmission.epoch,
            mutationId: "denied",
            spaceId: library.defaultSpaceId,
            baseRootOrderRevision: 0,
            title: "Denied",
          };
          assert.equal(
            failure(yield* call("t2_spaces_pages_create", input, readOnly)).code,
            "capability_denied",
          );
          assert.deepEqual(observer.prepare("PRAGMA data_version").get(), version);
          assert.deepEqual(
            (yield* service.listPages({ ...env, spaceId: library.defaultSpaceId })).items,
            [],
          );
        }),
      ),
  );
  it.effect("preserves real saved/conflict/receipt/epoch results without refreshing guards", () =>
    fixture(() =>
      Effect.gen(function* () {
        const library = decodeList(value(yield* call("t2_spaces_list", env)));
        const input = {
          ...env,
          receiptEpoch: library.mutationAdmission.epoch,
          mutationId: "create",
          spaceId: library.defaultSpaceId,
          baseRootOrderRevision: 0,
          title: "Original",
        };
        const created = decodeCreated(value(yield* call("t2_spaces_pages_create", input)));
        assert.equal(created.status, "saved");
        if (created.status !== "saved") return;
        assert.deepEqual(value(yield* call("t2_spaces_pages_create", input)), created);
        const update = {
          ...env,
          receiptEpoch: input.receiptEpoch,
          mutationId: "update",
          pageId: created.page.id,
          baseRevision: 0,
          title: "Current",
        };
        assert.equal(value(yield* call("t2_spaces_pages_update", update)).page.revision, 1);
        const conflict = value(
          yield* call("t2_spaces_pages_update", { ...update, mutationId: "stale", title: "Stale" }),
        );
        assert.equal(conflict.status, "conflict");
        assert.equal(conflict.current.pages[0].title, "Current");
        assert.deepEqual(
          decodeLookup(
            value(
              yield* call("t2_spaces_receipts_get", {
                request: { operation: "createPage", input },
              }),
            ),
          ),
          { status: "found", receipt: { operation: "createPage", result: created } },
        );
        yield* TestClock.setTime(Date.parse(library.mutationAdmission.acceptsUntil) + 1);
        assert.deepEqual(value(yield* call("t2_spaces_pages_create", input)), created);
        assert.equal(
          failure(
            yield* call("t2_spaces_pages_update", {
              ...update,
              mutationId: "expired",
              baseRevision: 1,
              receiptEpoch: input.receiptEpoch,
            }),
          )._tag,
          "SpaceMutationAdmissionError",
        );
        assert.equal(
          (yield* (yield* SpacesService.SpacesService).getPage({ ...env, pageId: created.page.id }))
            .page.title,
          "Current",
        );
      }),
    ),
  );
  it.effect(
    "refuses missing capability and invocation environment mismatches for external and provider callers and honors disable",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          for (const invocation of [
            scope,
            {
              ...scope,
              client: undefined,
              thread: {
                threadId,
                providerSessionId: "provider",
                providerInstanceId: ProviderInstanceId.make("codex"),
              },
            },
          ]) {
            assert.equal(
              failure(
                yield* call("t2_spaces_list", env, { ...invocation, capabilities: new Set() }),
              )._tag,
              "McpCapabilityUnavailableError",
            );
            assert.equal(
              failure(
                yield* call("t2_spaces_list", env, {
                  ...invocation,
                  environmentId: EnvironmentId.make("foreign"),
                }),
              )._tag,
              "SpaceEnvironmentMismatchError",
            );
            assert.equal(
              failure(yield* call("t2_spaces_list", { environmentId: "foreign" }, invocation))._tag,
              "SpaceEnvironmentMismatchError",
            );
          }
          const oversizedForeign = "PRIVATE".repeat(100000);
          const bounded = failure(
            yield* call("t2_spaces_list", { environmentId: oversizedForeign }),
          );
          assert.equal(bounded._tag, "SpaceEnvironmentMismatchError");
          assert.notInclude(JSON.stringify(bounded), "PRIVATE");
          const settings = yield* Settings.ServerSettingsService;
          yield* settings.updateSettings({ spacesEnabled: false });
          assert.equal(failure(yield* call("t2_spaces_list", env))._tag, "SpacesDisabledError");
          yield* settings.updateSettings({ spacesEnabled: true });
          assert.isDefined(decodeList(value(yield* call("t2_spaces_list", env))).defaultSpaceId);
        }),
      ),
  );
  it.effect(
    "allows document writes from a live approval-required provider and refuses the ended caller before a DB commit",
    () =>
      fixture((dbPath, stopCaller) =>
        Effect.gen(function* () {
          const provider = {
            ...scope,
            client: undefined,
            thread: {
              threadId,
              providerSessionId: "provider",
              providerInstanceId: ProviderInstanceId.make("codex"),
            },
          };
          const library = decodeList(value(yield* call("t2_spaces_list", env, provider)));
          const input = {
            ...env,
            mutationId: "provider",
            receiptEpoch: library.mutationAdmission.epoch,
            title: "Provider",
          };
          assert.equal(value(yield* call("t2_spaces_create", input, provider)).status, "saved");
          const observer = yield* Effect.acquireRelease(
            Effect.sync(() => new NodeSqlite.DatabaseSync(dbPath, { readOnly: true })),
            (db) => Effect.sync(() => db.close()),
          );
          const before = observer.prepare("PRAGMA data_version").get();
          yield* stopCaller;
          assert.equal(
            failure(yield* call("t2_spaces_create", { ...input, mutationId: "ended" }, provider))
              .code,
            "parent_not_active",
          );
          assert.deepEqual(observer.prepare("PRAGMA data_version").get(), before);
        }),
      ),
  );
  it.effect("uses the disabled-by-default service gate even with a granted capability", () =>
    fixture(
      () =>
        Effect.gen(function* () {
          assert.equal(failure(yield* call("t2_spaces_list", env))._tag, "SpacesDisabledError");
        }),
      false,
    ),
  );
  it.effect(
    "rejects original excess keys and exact-over protocol envelopes with bounded errors before writes",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const library = decodeList(value(yield* call("t2_spaces_list", env)));
          const input = {
            ...env,
            receiptEpoch: library.mutationAdmission.epoch,
            mutationId: "raw",
            title: "",
          };
          const title = "x".repeat(
            1_048_576 - Buffer.byteLength(canonical({ operation: "createSpace", input })),
          );
          const exact = { ...input, title };
          assert.equal(
            Buffer.byteLength(canonical({ operation: "createSpace", input: exact })),
            1_048_576,
          );
          assert.deepEqual(failure(yield* call("t2_spaces_create", exact)), {
            _tag: "SpaceLimitExceededError",
            limit: "maxMutationBytes",
            actual: 1_048_576,
            maximum: 262144,
          });
          for (const args of [
            { ...input, title: "Safe", hidden: "DO_NOT_ECHO" },
            { ...exact, title: title + "x" },
            { ...input, title: "Safe", ["__proto__"]: { hidden: "DO_NOT_ECHO" } },
          ]) {
            const rejected = yield* call("t2_spaces_create", args).pipe(Effect.flip);
            const encoded = JSON.stringify(rejected);
            assert.isBelow(Buffer.byteLength(encoded), 2048);
            assert.notInclude(encoded, "DO_NOT_ECHO");
          }
          assert.equal(
            (yield* (yield* SpacesService.SpacesService).listSpaces(env)).items.length,
            1,
          );
        }),
      ),
  );
  it.effect(
    "preserves dangerous own opaque JSON through MCP decode, storage, reads and receipt fingerprints",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const service = yield* SpacesService.SpacesService;
          const library = yield* service.listSpaces(env);
          const created = yield* service.createPage({
            ...env,
            receiptEpoch: library.mutationAdmission.epoch,
            mutationId: "seed",
            spaceId: library.defaultSpaceId,
            baseRootOrderRevision: 0,
            title: "Opaque",
          });
          if (created.status !== "saved") return yield* Effect.die("Expected seed");
          const opaque = JSON.parse(
            '{"__proto__":{"own":"json"},"constructor":{"nested":["界",null,false]},"toString":"opaque"}',
          );
          const block = {
            ...opaque,
            id: "future",
            parentId: null,
            order: "00000000000000000000000000000001",
            type: "paragraph",
            version: 1,
            content: {
              ...opaque,
              runs: [
                { ...opaque, text: "Preserved", marks: [{ ...opaque, type: "bold", version: 1 }] },
              ],
            },
          };
          const input = {
            ...env,
            receiptEpoch: library.mutationAdmission.epoch,
            mutationId: "opaque",
            pageId: created.page.id,
            baseRevision: 0,
            generation: 0,
            mutations: [{ kind: "insert", block }],
          };
          const applied = decodeApplied(value(yield* call("t2_spaces_blocks_apply", input)));
          assert.equal(applied.status, "saved");
          const window = decodeWindow(
            value(
              yield* call("t2_spaces_blocks_read", {
                ...env,
                pageId: created.page.id,
                revision: 1,
              }),
            ),
          );
          assert.equal(canonical(window.blocks[0]), canonical(block));
          assert.equal(Object.hasOwn(window.blocks[0]!, "__proto__"), true);
          const captured = decodeCapture(
            value(
              yield* call(
                "t2_spaces_context_capture",
                { ...env, contextId: "mcp-snapshot", target: { kind: "block", blockId: "future" } },
                { ...scope, client: { ...scope.client!, access: "read-only" } },
              ),
            ),
          );
          if (captured.status !== "captured") return yield* Effect.die("Expected current capture");
          assert.equal(captured.record.snapshot.text, "Preserved");
          assert.deepEqual(captured.record.snapshot.sources, [
            {
              environmentId,
              spaceId: created.page.spaceId,
              pageId: created.page.id,
              revision: 1,
              blockIds: [C.SpaceBlockId.make("future")],
            },
          ]);
          const crypto = yield* Crypto.Crypto;
          const digest = yield* crypto.digest(
            "SHA-256",
            new TextEncoder().encode(serializeSpaceContextSnapshotForHash(captured.record)),
          );
          assert.equal(
            captured.record.snapshot.contentHash,
            `sha256:${Buffer.from(digest).toString("hex")}`,
          );

          assert.deepEqual(value(yield* call("t2_spaces_blocks_apply", input)), applied);
          assert.equal(
            failure(
              yield* call("t2_spaces_blocks_apply", {
                ...input,
                mutations: [{ kind: "insert", block: { ...block, toString: "changed" } }],
              }),
            )._tag,
            "SpaceMutationIdMismatchError",
          );
        }),
      ),
  );
});
