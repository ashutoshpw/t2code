import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, SPACE_PAGE_SHARE_HEADER } from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as FileSystem from "effect/FileSystem";
import { HttpPlatform, HttpRouter } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CloudManagedEndpointRuntime } from "../cloud/ManagedEndpointRuntime.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Settings from "../serverSettings.ts";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import * as PageShareHttp from "./pageShareHttp.ts";
import * as PageShareService from "./PageShareService.ts";
import * as SpacesService from "./SpacesService.ts";
import { databaseKit, oid, pid } from "./service/Databases.testkit.ts";

const environmentId = EnvironmentId.make("page-share-database-environment");
const env = { environmentId };

export const hostname = Ref.makeUnsafe<string | null>("env.t2.test");
const layerConnect = Layer.mock(CloudManagedEndpointRuntime)({
  inspectConnector: Effect.map(Ref.get(hostname), (value) => ({
    pid: 4242,
    readyConnections: 1,
    hostname: value,
    protocol: "http2",
  })),
});
const layerSpaces = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return SpacesService.layerFromPath(config.spacesDbPath, {
      assetsDir: config.spacesAssetsDir,
      stagingDir: config.spacesStagingDir,
    });
  }),
).pipe(
  Layer.provide(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(environmentId),
    }),
  ),
  Layer.provideMerge(Settings.layerTest({ spacesEnabled: true, spacesPageSharingEnabled: true })),
);
const layerAnalytics = Layer.succeed(
  AnalyticsService.AnalyticsService,
  AnalyticsService.AnalyticsService.of({
    record: () => Effect.void,
    flush: Effect.void,
    recordOwners: () => Effect.void,
  }),
);
const layerShare = (spaces: typeof layerSpaces) =>
  PageShareService.layer.pipe(
    Layer.provide(layerAnalytics),
    Layer.provideMerge(spaces),
    Layer.provide(layerConnect),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "page-share-db-" })),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(NodeHttpPlatform.layer),
  );
export const layerTest = layerShare(layerSpaces);

/**
 * The same stack with `describeSharedDatabase` held open: each call announces itself on
 * `entered`, then waits for `gate`, so a test can hold database permits without timing.
 */
export const layerGated = (gate: Deferred.Deferred<void>, entered: Queue.Queue<void>) =>
  layerShare(
    Layer.effect(
      SpacesService.SpacesService,
      Effect.map(SpacesService.SpacesService, (real) =>
        SpacesService.SpacesService.of({
          ...real,
          describeSharedDatabase: (input) =>
            Queue.offer(entered, undefined).pipe(
              Effect.andThen(Deferred.await(gate)),
              Effect.andThen(real.describeSharedDatabase(input)),
            ),
        }),
      ),
    ).pipe(Layer.provideMerge(layerSpaces)),
  );

/** The same stack with `resolveSharedRowAssetFile` held open, like `layerGated`. */
export const layerGatedRowAssets = (gate: Deferred.Deferred<void>, entered: Queue.Queue<void>) =>
  layerShare(
    Layer.effect(
      SpacesService.SpacesService,
      Effect.map(SpacesService.SpacesService, (real) =>
        SpacesService.SpacesService.of({
          ...real,
          resolveSharedRowAssetFile: (input) =>
            Queue.offer(entered, undefined).pipe(
              Effect.andThen(Deferred.await(gate)),
              Effect.andThen(real.resolveSharedRowAssetFile(input)),
            ),
        }),
      ),
    ).pipe(Layer.provideMerge(layerSpaces)),
  );

/** The refusal reason a viewer sees, or the tag of a request that did not fit its view. */
export const reason = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.flip(effect), (error) =>
    "reason" in error ? String(error.reason) : error._tag,
  );

export const ids = {
  note: pid("note001"),
  points: pid("pts0001"),
  secret: pid("secr001"),
  files: pid("files01"),
  status: pid("stat001"),
};
export const options = { a: oid("opta01"), b: oid("optb01"), c: oid("optc01") };
export const SECRET = "TOPSECRET-VALUE";
const run = (text: string) => [{ text, marks: [] }];

const png = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  ),
);

/** A shared host page holding a Tasks database: three rows, one hidden "Secret" column. */
export const sharedDatabase = Effect.fn("PageShareDatabasesTest.sharedDatabase")(function* (
  options_: { readonly shareHost?: boolean } = {},
) {
  yield* Ref.set(hostname, "env.t2.test");
  const spaces = yield* SpacesService.SpacesService;
  const shares = yield* PageShareService.SpacePageShareService;
  const library = yield* spaces.listSpaces(env);
  const common = { ...env, receiptEpoch: library.mutationAdmission.epoch };
  const spaceId = library.defaultSpaceId;
  let counter = 0;
  const next = (label: string) => C.SpaceMutationId.make(`${label}-${++counter}`);
  const rootPage = Effect.fn("PageShareDatabasesTest.rootPage")(function* (title: string) {
    const listing = yield* spaces.listPages({ ...env, spaceId });
    const result = yield* spaces.createPage({
      ...common,
      mutationId: next("root"),
      spaceId,
      title,
      baseRootOrderRevision: listing.space.rootOrderRevision,
    });
    if (result.status !== "saved") return yield* Effect.die("Expected root page");
    return result.page.id;
  });
  const childPage = Effect.fn("PageShareDatabasesTest.childPage")(function* (
    parent: C.SpacePageId,
    title: string,
  ) {
    const placement = { pageId: parent, parentId: null, beforeBlockId: null };
    const inspected = yield* spaces.inspectStructure({
      ...env,
      target: { kind: "blocks", pageId: parent, blockIds: [] },
      destination: { kind: "child", placement },
    });
    const result = yield* spaces.createChildPage({
      ...common,
      mutationId: next("child"),
      title,
      placement,
      guards: inspected.guards,
    });
    if (result.status !== "saved") return yield* Effect.die("Expected child page");
    return result.page.id;
  });
  const recover = Effect.fn("PageShareDatabasesTest.recover")(function* (
    pageId: C.SpacePageId,
    recovery: "trash" | "restore",
  ) {
    const inspected = yield* spaces.inspectStructure({
      ...env,
      target: { kind: "page", pageId },
      recovery,
    });
    const input = {
      ...common,
      pageId,
      mutationId: next(recovery),
      guards: inspected.guards,
    };
    yield* recovery === "trash" ? spaces.trashPage(input) : spaces.restorePage(input);
  });
  const insertBlock = Effect.fn("PageShareDatabasesTest.insertBlock")(function* (
    pageId: C.SpacePageId,
    block: C.SpaceBlock,
  ) {
    const page = yield* spaces.getPage({ ...env, pageId });
    yield* spaces.applyBlockBatch({
      ...common,
      mutationId: next("block"),
      pageId,
      baseRevision: page.page.revision,
      generation: 0,
      mutations: [{ kind: "insert", block }],
    });
  });
  const linkedBlock = (
    id: string,
    databaseId: C.SpaceDatabaseId,
    viewIds: readonly C.SpaceViewId[],
  ): C.SpaceBlock => ({
    id: C.SpaceBlockId.make(id),
    parentId: null,
    order: "00000000000000000000000000000090",
    type: "database",
    version: 1,
    content: { databaseId, viewIds },
  });
  const uploadImage = Effect.fn("PageShareDatabasesTest.uploadImage")(function* (name: string) {
    const minted = yield* spaces.createAssetUpload(
      {
        environmentId,
        requestId: next(name),
        expectedBytes: png.length,
        mediaKind: "image",
        mimeType: "image/png",
        name: `${name}.png`,
      },
      "owner",
    );
    yield* spaces.receiveAssetUpload(
      minted.relativeUrl.split("/").at(-1)!,
      String(png.length),
      Stream.make(new Uint8Array(png)),
    );
    return (yield* spaces.finalizeAssetUpload(
      { environmentId, uploadId: minted.uploadId },
      "owner",
    )).assetId;
  });
  const attachImage = (pageId: C.SpacePageId, blockId: string, assetId: C.SpaceAssetId) =>
    insertBlock(pageId, {
      id: C.SpaceBlockId.make(blockId),
      parentId: null,
      order: "00000000000000000000000000000001",
      type: "image",
      version: 1,
      content: { assetId },
    });

  const host = yield* rootPage("Host");
  const kit = databaseKit(spaces, common, spaceId);
  const created = yield* kit.create("Tasks", {
    appendToPageId: host,
    properties: [
      { id: ids.note, name: "Note", type: "text" },
      { id: ids.points, name: "Points", type: "number" },
      { id: ids.secret, name: "Secret", type: "text" },
      { id: ids.files, name: "Files", type: "files" },
      {
        id: ids.status,
        name: "Status",
        type: "select",
        options: [
          { id: options.a, name: "Alpha", color: "red" },
          { id: options.b, name: "Bravo", color: "blue" },
          { id: options.c, name: "Charlie", color: "green" },
        ],
      },
    ],
  });
  const dataSourceId = created.dataSourceId;
  const blockId = created.block!.blockId;
  const rowIds = (yield* kit.addRows(dataSourceId, [
    {
      title: "Row one",
      cells: {
        [ids.note]: run("first note"),
        [ids.points]: 1,
        [ids.secret]: run(`${SECRET}-1`),
        [ids.status]: options.a,
      },
    },
    {
      title: "Row two",
      cells: {
        [ids.note]: run("second note"),
        [ids.points]: 2,
        [ids.secret]: run(`${SECRET}-2`),
        [ids.status]: options.b,
      },
    },
    {
      title: "Row three",
      cells: { [ids.points]: 3, [ids.secret]: run(`${SECRET}-3`), [ids.status]: options.c },
    },
  ])).rows.map((row) => row.pageId);
  const updateView = (viewId: C.SpaceViewId, patch: Partial<C.SpaceViewUpdateInput>) =>
    spaces.updateView({ ...common, mutationId: next("view"), viewId, ...patch });
  const createView = (
    name: string,
    type: C.SpaceViewType,
    patch: Partial<C.SpaceViewCreateInput>,
  ) =>
    spaces.createView({
      ...common,
      mutationId: next("make-view"),
      dataSourceId,
      name,
      type,
      beforeViewId: null,
      ...patch,
    });
  yield* updateView(created.viewId, { properties: { set: { [ids.secret]: { visible: false } } } });
  const token =
    options_.shareHost === false ? "" : (yield* shares.create({ pageId: host })).url.split("#")[1]!;
  function request(): { blockId: C.SpaceBlockId; viewId: C.SpaceViewId };
  function request<T extends object>(
    extra: T,
  ): { blockId: C.SpaceBlockId; viewId: C.SpaceViewId } & T;
  function request(extra: object = {}) {
    return { blockId, viewId: created.viewId, ...extra };
  }
  return {
    spaces,
    shares,
    kit,
    common,
    spaceId,
    host,
    token,
    created,
    databaseId: created.databaseId,
    dataSourceId,
    viewId: created.viewId,
    blockId,
    rowIds,
    rootPage,
    childPage,
    recover,
    insertBlock,
    linkedBlock,
    uploadImage,
    attachImage,
    updateView,
    createView,
    request,
    credentialOf: (url: string) => url.slice(url.indexOf("#") + 1),
  };
});

export type SharedDatabase = Effect.Success<ReturnType<typeof sharedDatabase>>;

const jsonText = (value: unknown) => JSON.stringify(value);

/** The routes mounted on a web handler, as the share tests drive them. */
export const httpHarness = Effect.fn("PageShareDatabasesTest.httpHarness")(function* () {
  const context = yield* Effect.context<
    PageShareService.SpacePageShareService | FileSystem.FileSystem | HttpPlatform.HttpPlatform
  >();
  const { handler, dispose } = HttpRouter.toWebHandler(
    PageShareHttp.layer.pipe(Layer.provide(Layer.succeedContext(context))),
    { disableLogger: true },
  );
  yield* Effect.addFinalizer(() => Effect.promise(dispose));
  const get = (path: string, params: Record<string, string>, token?: string) =>
    Effect.promise(() =>
      handler(
        new Request(`http://t2.test${path}?${new URLSearchParams(params)}`, {
          headers: token === undefined ? {} : { [SPACE_PAGE_SHARE_HEADER]: token },
        }),
        context,
      ),
    );
  const post = (path: string, params: Record<string, string>, token: string) =>
    Effect.promise(() =>
      handler(
        new Request(`http://t2.test${path}?${new URLSearchParams(params)}`, {
          method: "POST",
          headers: { [SPACE_PAGE_SHARE_HEADER]: token, "content-type": "application/json" },
          body: '{"rows":[{"title":"written"}]}',
        }),
        context,
      ),
    );
  const postJson = (
    path: string,
    body: unknown,
    token?: string,
    options: { readonly params?: Record<string, string>; readonly raw?: string } = {},
  ) =>
    Effect.promise(() =>
      handler(
        new Request(`http://t2.test${path}?${new URLSearchParams(options.params ?? {})}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(token === undefined ? {} : { [SPACE_PAGE_SHARE_HEADER]: token }),
          },
          body: options.raw ?? jsonText(body),
        }),
        context,
      ),
    );
  return { get, post, postJson };
});
