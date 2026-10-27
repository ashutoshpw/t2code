import {
  ListToolsResultSchema,
  CallToolResultSchema,
  ToolSchema,
  type Tool as SdkTool,
} from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
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
function outputValidator(schema: NonNullable<SdkTool["outputSchema"]>) {
  const { properties, required, ...rest } = schema;
  return new AjvJsonSchemaValidator().getValidator({
    ...rest,
    ...(properties === undefined ? {} : { properties }),
    ...(required === undefined ? {} : { required }),
  });
}
const call = Effect.fn("SpacesMcpTest.call")(function* (
  name: string,
  args: unknown,
  invocation = scope,
) {
  const server = yield* McpServer.McpServer;
  // JSON round trips exercise the registered advertised parameter codec and actual result encoding.
  const result = yield* server
    .callTool({ name, arguments: JSON.parse(JSON.stringify(args)) })
    .pipe(
      Effect.provideService(Invocation.McpInvocationContext, invocation),
      Effect.provideService(McpSchema.McpServerClient, client),
    );
  const wire = CallToolResultSchema.parse(JSON.parse(JSON.stringify(result)));
  if (!wire.isError) {
    const descriptor = server.tools.find((entry) => entry.tool.name === name)?.tool;
    const tool = ToolSchema.parse(JSON.parse(JSON.stringify(descriptor)));
    assert.isDefined(tool.outputSchema);
    const checked = outputValidator(tool.outputSchema!)(wire.structuredContent);
    assert.isTrue(checked.valid, checked.errorMessage);
  }
  return result;
});
it.layer(Layer.merge(NodeServices.layer, NodeCrypto.layer))("registered Spaces MCP", (it) => {
  it.effect("SDK accepts every registered descriptor and preserves union validation", () =>
    fixture(() =>
      Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const list = ListToolsResultSchema.parse(
          JSON.parse(JSON.stringify({ tools: server.tools.map((entry) => entry.tool) })),
        );
        for (const tool of list.tools) {
          assert.isDefined(tool.outputSchema);
          outputValidator(tool.outputSchema!);
        }
        for (const name of [
          "t2_spaces_pages_create",
          "t2_spaces_references_resolve",
          "t2_spaces_context_capture",
        ]) {
          const schema = list.tools.find((tool) => tool.name === name)?.outputSchema;
          assert.isDefined(schema);
          const validate = outputValidator(schema!);
          for (const invalid of [null, [], {}, { status: "bogus" }, { status: "saved" }])
            assert.isFalse(validate(invalid).valid);
        }
      }),
    ),
  );
  it.effect("SDK accepts capability object envelopes across disabled and enabled states", () =>
    fixture(
      () =>
        Effect.gen(function* () {
          assert.deepEqual(value(yield* call("t2_spaces_capability", env)), { capability: null });
          const settings = yield* Settings.ServerSettingsService;
          yield* settings.updateSettings({ spacesEnabled: true });
          const current = value(yield* call("t2_spaces_capability", env));
          assert.equal(current.capability.version, 2);
          assert.equal(current.capability.features.contextCapture, true);
          yield* settings.updateSettings({ spacesEnabled: false });
          assert.deepEqual(value(yield* call("t2_spaces_capability", env)), { capability: null });
        }),
      false,
    ),
  );
  it.effect("SDK validates encoded outputs from every registered Spaces operation", () =>
    fixture(() =>
      Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const called = new Set<string>();
        const send = Effect.fnUntraced(function* (name: string, args: unknown) {
          const result = yield* call(name, args);
          called.add(name);
          return result;
        });
        const library = value(yield* send("t2_spaces_list", env));
        const admission = { ...env, receiptEpoch: library.mutationAdmission.epoch };
        assert.equal(value(yield* send("t2_spaces_capability", env)).capability.version, 2);
        const createdSpace = value(
          yield* send("t2_spaces_create", { ...admission, mutationId: "sdk-space", title: "SDK" }),
        );
        const renamed = value(
          yield* send("t2_spaces_rename", {
            ...admission,
            mutationId: "sdk-rename",
            spaceId: createdSpace.space.id,
            baseRevision: createdSpace.space.revision,
            title: "SDK space",
          }),
        );
        value(
          yield* send("t2_spaces_set_default", {
            ...admission,
            mutationId: "sdk-default",
            spaceId: renamed.space.id,
            baseRevision: renamed.space.revision,
            defaultSpaceId: library.defaultSpaceId,
            baseDefaultRevision: library.items.find(
              (item: { id: string }) => item.id === library.defaultSpaceId,
            ).revision,
          }),
        );
        const createInput = {
          ...admission,
          mutationId: "sdk-page",
          spaceId: renamed.space.id,
          baseRootOrderRevision: 0,
          title: "SDK page",
        };
        const page = value(yield* send("t2_spaces_pages_create", createInput)).page;
        value(yield* send("t2_spaces_pages_list", { ...env, spaceId: page.spaceId }));
        value(yield* send("t2_spaces_pages_get", { ...env, pageId: page.id }));
        const updated = value(
          yield* send("t2_spaces_pages_update", {
            ...admission,
            mutationId: "sdk-title",
            pageId: page.id,
            baseRevision: page.revision,
            title: "SDK updated",
          }),
        );
        const applied = value(
          yield* send("t2_spaces_blocks_apply", {
            ...admission,
            mutationId: "sdk-block",
            pageId: page.id,
            baseRevision: updated.page.revision,
            generation: 0,
            mutations: [
              {
                kind: "insert",
                block: {
                  id: "sdk-block",
                  type: "paragraph",
                  version: 1,
                  parentId: null,
                  order: "00000000000000000000000000000001",
                  content: { runs: [{ text: "needle", marks: [] }] },
                },
              },
            ],
          }),
        );
        value(
          yield* send("t2_spaces_blocks_read", {
            ...env,
            pageId: page.id,
            revision: applied.revision,
          }),
        );
        const placement = { pageId: page.id, parentId: null, beforeBlockId: null };
        const inspect = value(
          yield* send("t2_spaces_structure_inspect", {
            ...env,
            target: { kind: "blocks", pageId: page.id, blockIds: [] },
            destination: { kind: "child", placement },
          }),
        );
        const child = value(
          yield* send("t2_spaces_pages_create_child", {
            ...admission,
            mutationId: "sdk-child",
            title: "SDK child",
            placement,
            guards: inspect.guards,
          }),
        );
        const destination = { kind: "root", spaceId: page.spaceId, beforePageId: null };
        const moving = value(
          yield* send("t2_spaces_structure_inspect", {
            ...env,
            target: { kind: "page", pageId: child.page.id },
            destination,
          }),
        );
        value(
          yield* send("t2_spaces_pages_move", {
            ...admission,
            mutationId: "sdk-move-page",
            pageId: child.page.id,
            destination,
            guards: moving.guards,
          }),
        );
        const blockPlacement = { pageId: child.page.id, parentId: null, beforeBlockId: null };
        const movingBlock = value(
          yield* send("t2_spaces_structure_inspect", {
            ...env,
            target: { kind: "blocks", pageId: page.id, blockIds: ["sdk-block"] },
            destination: { kind: "child", placement: blockPlacement },
          }),
        );
        value(
          yield* send("t2_spaces_blocks_move", {
            ...admission,
            mutationId: "sdk-move-block",
            sourcePageId: page.id,
            blockIds: ["sdk-block"],
            destination: blockPlacement,
            guards: movingBlock.guards,
          }),
        );
        const resolved = value(
          yield* send("t2_spaces_references_resolve", {
            ...env,
            target: { kind: "block", blockId: "sdk-block" },
          }),
        );
        assert.equal(resolved.page.id, child.page.id);
        const captured = value(
          yield* send("t2_spaces_context_capture", {
            ...env,
            contextId: "sdk-context",
            target: { kind: "block", blockId: "sdk-block" },
          }),
        );
        assert.equal(captured.record.snapshot.text, "needle");
        let searched = yield* send("t2_spaces_search", { ...env, query: "needle" });
        if (searched.isError) {
          assert.equal(failure(searched).reason, "building");
          searched = yield* send("t2_spaces_search", { ...env, query: "needle" });
        }
        assert.isNotEmpty(value(searched).items);
        const recover = Effect.fnUntraced(function* (
          operation: C.SpaceRecoveryOperation,
          name: string,
          mutationId: string,
        ) {
          const inspected = value(
            yield* send("t2_spaces_structure_inspect", {
              ...env,
              target: { kind: "page", pageId: child.page.id },
              recovery: operation,
            }),
          );
          return value(
            yield* send(name, {
              ...admission,
              mutationId,
              pageId: child.page.id,
              guards: inspected.guards,
            }),
          );
        });
        yield* recover("trash", "t2_spaces_pages_trash", "sdk-trash");
        assert.isNotEmpty(value(yield* send("t2_spaces_trash_list", env)).items);
        assert.equal(
          value(
            yield* send("t2_spaces_references_resolve", {
              ...env,
              target: { kind: "block", blockId: "sdk-block" },
            }),
          ).status,
          "trashed",
        );
        assert.equal(
          value(
            yield* send("t2_spaces_context_capture", {
              ...env,
              contextId: "sdk-unavailable",
              target: { kind: "block", blockId: "sdk-block" },
            }),
          ).status,
          "unavailable",
        );
        yield* recover("restore", "t2_spaces_pages_restore", "sdk-restore");
        yield* recover("trash", "t2_spaces_pages_trash", "sdk-trash-again");
        yield* recover("permanentlyDelete", "t2_spaces_pages_permanently_delete", "sdk-purge");
        assert.equal(
          value(
            yield* send("t2_spaces_references_resolve", {
              ...env,
              target: { kind: "page", pageId: child.page.id },
            }),
          ).status,
          "deleted",
        );
        assert.equal(
          value(
            yield* send("t2_spaces_context_capture", {
              ...env,
              contextId: "sdk-deleted",
              target: { kind: "block", blockId: "sdk-block" },
            }),
          ).status,
          "deleted",
        );
        assert.equal(
          value(
            yield* send("t2_spaces_receipts_get", {
              request: { operation: "createPage", input: createInput },
            }),
          ).receipt.result.page.id,
          page.id,
        );
        assert.sameMembers(
          [...called],
          server.tools.map((entry) => entry.tool.name),
        );
      }),
    ),
  );
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
