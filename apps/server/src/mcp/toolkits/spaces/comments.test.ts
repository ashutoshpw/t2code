import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";
import * as AssetSigner from "../../../assets/AssetSigner.ts";
import * as NativeIcons from "../../../assets/NativeAppIconResolver.ts";
import * as Secrets from "../../../auth/ServerSecretStore.ts";
import * as Config from "../../../config.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Favicon from "../../../project/ProjectFaviconResolver.ts";
import * as ProjectLoader from "../../../project/T2ProjectFileLoader.ts";
import * as RepositoryIdentityResolver from "../../../project/RepositoryIdentityResolver.ts";
import * as Settings from "../../../serverSettings.ts";
import * as BuiltInDrivers from "../../../sourceControl/builtInDrivers.ts";
import * as SpacesService from "../../../spaces/SpacesService.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";

const environmentId = EnvironmentId.make("spaces-mcp");
const threadId = ThreadId.make("comment-agent");
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
const external: Invocation.McpInvocationScope = {
  environmentId,
  requestNamespace: "spaces-test",
  thread: undefined,
  client: { sessionId: "external", label: "external", access: "auto" },
  capabilities: new Set(["spaces"]),
  issuedAt: 0,
};
const agent: Invocation.McpInvocationScope = {
  ...external,
  client: undefined,
  thread: {
    threadId,
    providerSessionId: "provider",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
};
const decodeList = Schema.decodeUnknownSync(C.SpaceCommentsListResult);
const decodeSaved = Schema.decodeUnknownSync(C.SpaceCommentMutationResult);

const fixture = Effect.fn("SpacesCommentsMcpTest.fixture")(function* <A, E, R>(
  use: Effect.Effect<A, E, R | SpacesService.SpacesService | McpServer.McpServer>,
) {
  const lifetime = yield* Effect.scope;
  const clock = yield* Clock.Clock;
  const configContext = yield* Layer.buildWithScope(
    Config.ServerConfig.layerTest(process.cwd(), { prefix: "spaces-comments-mcp-" }),
    lifetime,
  );
  const config = Context.get(configContext, Config.ServerConfig);
  const configLayer = Layer.succeedContext(configContext);
  const settings = Settings.layerTest({ spacesEnabled: true });
  const layerService = SpacesService.layerFromPath(config.spacesDbPath, {
    assetsDir: config.spacesAssetsDir,
    stagingDir: config.spacesStagingDir,
  }).pipe(
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(environmentId),
      }),
    ),
    Layer.provide(settings),
  );
  const platform = Layer.mergeAll(
    configLayer,
    layerService,
    settings,
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: () => Effect.succeed(liveThreadShell(threadId, {})),
    }),
    Secrets.layer.pipe(Layer.provide(configLayer)),
    AssetSigner.layer.pipe(
      Layer.provideMerge(Secrets.layer.pipe(Layer.provide(configLayer))),
      Layer.provide(NodePlatformCrypto.layerMac),
    ),
    RepositoryIdentityResolver.layer,
    WorkspacePaths.layer,
    Favicon.layer.pipe(Layer.provide(WorkspacePaths.layer), Layer.provide(ProjectLoader.layer)),
    NativeIcons.layer.pipe(Layer.provide(configLayer)),
    NodeHttpPlatform.layer,
    Layer.mock(Orchestrator.OrchestratorV2)({}),
    Layer.succeed(BuiltInDrivers.SourceControlDrivers, []),
    Layer.succeed(Clock.Clock, clock),
  ).pipe(Layer.provideMerge(NodeServices.layer), Layer.provideMerge(NodePlatformCrypto.layer));
  const context = yield* Layer.buildWithScope(
    McpHttpServer.layerSpacesToolkit.pipe(
      Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
      Layer.provideMerge(platform),
    ),
    lifetime,
  );
  return yield* use.pipe(Effect.provide(context));
});

const call = Effect.fn("SpacesCommentsMcpTest.call")(function* (
  args: unknown,
  invocation = external,
) {
  const server = yield* McpServer.McpServer;
  return yield* server
    .callTool({ name: "t2_spaces_comments", arguments: JSON.parse(JSON.stringify(args)) })
    .pipe(
      Effect.provideService(Invocation.McpInvocationContext, invocation),
      Effect.provideService(McpSchema.McpServerClient, client),
    );
});
const json = (result: McpSchema.CallToolResult) => {
  const content = result.content[0];
  if (content?.type !== "text") throw Error("Expected JSON text");
  return JSON.parse(content.text);
};

const seedThread = Effect.fn("SpacesCommentsMcpTest.seed")(function* () {
  const service = yield* SpacesService.SpacesService;
  const env = { environmentId };
  const library = yield* service.listSpaces(env);
  const common = { ...env, receiptEpoch: library.mutationAdmission.epoch };
  const page = yield* service.createPage({
    ...common,
    mutationId: "page",
    spaceId: library.defaultSpaceId,
    baseRootOrderRevision: 0,
    title: "Page",
  });
  if (page.status !== "saved") return yield* Effect.die("Expected saved page");
  const block = C.SpaceBlockId.make("para");
  yield* service.applyBlockBatch({
    ...common,
    mutationId: "seed",
    pageId: page.page.id,
    baseRevision: page.page.revision,
    generation: 0,
    mutations: [
      {
        kind: "insert",
        block: {
          id: block,
          parentId: null,
          order: "1".padStart(32, "0"),
          type: "paragraph",
          version: 1,
          content: { runs: [{ text: "teh", marks: [] }] },
        },
      },
    ],
  });
  const created = yield* service.createCommentThread({
    ...common,
    mutationId: "thread",
    pageId: page.page.id,
    blockId: block,
    anchor: { kind: "block" },
    body: [{ text: "fix the typo", marks: [] }],
  });
  return { common, pageId: page.page.id, commentThreadId: created.commentThreadId };
});

it.layer(NodeServices.layer)("Spaces comments MCP tool", (it) => {
  it.effect("lists threads and replies as the calling thread", () =>
    fixture(
      Effect.gen(function* () {
        const seeded = yield* seedThread();
        const listed = decodeList(
          json(yield* call({ action: "list", environmentId, pageId: seeded.pageId })),
        );
        assert.equal(listed.threads.length, 1);
        const byThread = decodeList(
          json(
            yield* call({
              action: "thread",
              environmentId,
              commentThreadId: seeded.commentThreadId,
            }),
          ),
        );
        assert.equal(byThread.threads[0]?.id, seeded.commentThreadId);
        const saved = decodeSaved(
          json(
            yield* call(
              {
                action: "reply",
                environmentId,
                mutationId: "agent-reply",
                receiptEpoch: seeded.common.receiptEpoch,
                commentThreadId: seeded.commentThreadId,
                text: "Fixed the typo.",
              },
              agent,
            ),
          ),
        );
        assert.equal(saved.commentThreadId, seeded.commentThreadId);
        const after = decodeList(
          json(yield* call({ action: "list", environmentId, pageId: seeded.pageId })),
        );
        assert.deepEqual(
          after.threads[0]?.comments.map((comment) => comment.author),
          [{ kind: "user" }, { kind: "agent", threadId }],
        );
      }),
    ),
  );

  it.effect("refuses replies without a thread caller or from a read-only credential", () =>
    fixture(
      Effect.gen(function* () {
        const seeded = yield* seedThread();
        const reply = {
          action: "reply",
          environmentId,
          mutationId: "refused",
          receiptEpoch: seeded.common.receiptEpoch,
          commentThreadId: seeded.commentThreadId,
          text: "hello",
        };
        const readOnly = {
          ...external,
          client: { ...external.client!, access: "read-only" as const },
        };
        for (const invocation of [external, readOnly]) {
          const refused = yield* call(reply, invocation);
          assert.equal(refused.isError, true);
        }
        const listed = yield* call(
          { action: "list", environmentId, pageId: seeded.pageId },
          readOnly,
        );
        assert.notEqual(listed.isError, true);
        const after = decodeList(json(listed));
        assert.equal(after.threads[0]?.comments.length, 1);
      }),
    ),
  );

  it.effect("offers list, thread and reply only", () =>
    fixture(
      Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const tool = server.tools.find((entry) => entry.tool.name === "t2_spaces_comments")?.tool;
        const actions = new Set<string>();
        const collect = (value: unknown): void => {
          if (Array.isArray(value)) value.forEach(collect);
          else if (typeof value === "object" && value !== null)
            for (const [key, child] of Object.entries(value)) {
              if (key === "action" && typeof child === "object" && child !== null) {
                const { const: literal, enum: options } = child as {
                  const?: string;
                  enum?: string[];
                };
                if (literal !== undefined) actions.add(literal);
                options?.forEach((option) => actions.add(option));
              }
              collect(child);
            }
        };
        collect(JSON.parse(JSON.stringify(tool?.inputSchema)));
        assert.deepEqual([...actions].toSorted(), ["list", "reply", "thread"]);
      }),
    ),
  );
});
