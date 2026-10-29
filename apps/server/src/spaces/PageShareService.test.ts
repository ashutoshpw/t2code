import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  SPACE_PAGE_SHARE_ASSET_ROUTE,
  SPACE_PAGE_SHARE_PAGE_ROUTE,
  SPACE_PAGE_SHARE_TTL_MS,
  SpaceSharedPage,
} from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpPlatform, HttpRouter } from "effect/http";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CloudManagedEndpointRuntime } from "../cloud/ManagedEndpointRuntime.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Settings from "../serverSettings.ts";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import * as PageShareHttp from "./pageShareHttp.ts";
import * as PageShareService from "./PageShareService.ts";
import * as SpacesService from "./SpacesService.ts";

const environmentId = EnvironmentId.make("page-share-environment");
const env = { environmentId };

// The Connect hostname the fake tunnel reports. Tests set it to null to simulate an unlink.
const hostname = Ref.makeUnsafe<string | null>("env.t2.test");
const layerConnect = Layer.mock(CloudManagedEndpointRuntime)({
  inspectConnector: Effect.map(Ref.get(hostname), (value) => ({
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
const recorded = Ref.makeUnsafe<ReadonlyArray<Readonly<Record<string, unknown>>>>([]);
const layerAnalytics = Layer.succeed(
  AnalyticsService.AnalyticsService,
  AnalyticsService.AnalyticsService.of({
    record: (event, properties) =>
      Ref.update(recorded, (events) => [...events, { event, ...properties }]),
    flush: Effect.void,
    recordOwners: () => Effect.void,
  }),
);
const layerTest = PageShareService.layer.pipe(
  Layer.provide(layerAnalytics),
  Layer.provideMerge(layerSpaces),
  Layer.provide(layerConnect),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "page-share-" })),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeHttpPlatform.layer),
);

const paragraph = (id: string, text: string): C.SpaceBlock => ({
  id: C.SpaceBlockId.make(id),
  parentId: null,
  order: "00000000000000000000000000000001",
  type: "paragraph",
  version: 1,
  content: { runs: [{ text, marks: [] }] },
});

const workspace = Effect.fn("PageShareTest.workspace")(function* () {
  yield* Ref.set(hostname, "env.t2.test");
  const spaces = yield* SpacesService.SpacesService;
  const shares = yield* PageShareService.SpacePageShareService;
  const library = yield* spaces.listSpaces(env);
  const common = { ...env, receiptEpoch: library.mutationAdmission.epoch };
  const rootPage = Effect.fn("PageShareTest.rootPage")(function* (title: string) {
    const listing = yield* spaces.listPages({ ...env, spaceId: library.defaultSpaceId });
    const result = yield* spaces.createPage({
      ...common,
      mutationId: `root-${title}`,
      spaceId: library.defaultSpaceId,
      title,
      baseRootOrderRevision: listing.space.rootOrderRevision,
    });
    if (result.status !== "saved") return yield* Effect.die("Expected root page");
    return result.page.id;
  });
  const childPage = Effect.fn("PageShareTest.childPage")(function* (
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
      mutationId: `child-${title}`,
      title,
      placement,
      guards: inspected.guards,
    });
    if (result.status !== "saved") return yield* Effect.die("Expected child page");
    return result.page.id;
  });
  const write = Effect.fn("PageShareTest.write")(function* (
    pageId: C.SpacePageId,
    id: string,
    text: string,
  ) {
    const page = yield* spaces.getPage({ ...env, pageId });
    yield* spaces.applyBlockBatch({
      ...common,
      mutationId: `write-${id}`,
      pageId,
      baseRevision: page.page.revision,
      generation: 0,
      mutations: [{ kind: "insert", block: paragraph(id, text) }],
    });
  });
  const move = Effect.fn("PageShareTest.move")(function* (
    pageId: C.SpacePageId,
    destination: C.SpacePageDestination,
    mutationId: string,
  ) {
    const inspected = yield* spaces.inspectStructure({
      ...env,
      target: { kind: "page", pageId },
      destination,
    });
    yield* spaces.movePage({
      ...common,
      pageId,
      mutationId: C.SpaceMutationId.make(mutationId),
      destination,
      guards: inspected.guards,
    });
  });
  const trash = Effect.fn("PageShareTest.trash")(function* (pageId: C.SpacePageId) {
    const inspected = yield* spaces.inspectStructure({
      ...env,
      target: { kind: "page", pageId },
      recovery: "trash",
    });
    yield* spaces.trashPage({
      ...common,
      pageId,
      mutationId: C.SpaceMutationId.make(`trash-${pageId}`),
      guards: inspected.guards,
    });
  });
  const credentialOf = (url: string) => url.slice(url.indexOf("#") + 1);
  return {
    spaces,
    shares,
    library,
    rootPage,
    childPage,
    write,
    move,
    trash,
    credentialOf,
  };
});

const reason = <A, E extends { readonly reason: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.flip(effect), (error) => error.reason);

it.effect("shows the shared page and its sub-pages but nothing outside the tree", () =>
  Effect.gen(function* () {
    const { shares, rootPage, childPage, write, credentialOf } = yield* workspace();
    const parent = yield* rootPage("Parent");
    const shared = yield* childPage(parent, "Shared");
    const nested = yield* childPage(shared, "Nested");
    const sibling = yield* childPage(parent, "Sibling");
    const elsewhere = yield* rootPage("Elsewhere");
    yield* write(shared, "intro", "hello viewers");

    const { url, share } = yield* shares.create({ pageId: shared });
    assert.isTrue(url.startsWith("https://env.t2.test/shared-page#"));
    assert.equal(share.host, "env.t2.test");
    assert.equal(
      Date.parse(share.expiresAt) - Date.parse(share.createdAt),
      SPACE_PAGE_SHARE_TTL_MS,
    );
    const token = credentialOf(url);

    const root = yield* shares.page(token);
    assert.equal(root.page.title, "Shared");
    assert.deepEqual(root.breadcrumb, [{ id: shared, title: "Shared" }]);
    assert.deepEqual(
      root.children.map((child) => child.id),
      [nested],
    );
    assert.isTrue(root.window.blocks.some((block) => block.id === "intro"));

    const inner = yield* shares.page(token, nested);
    assert.deepEqual(
      inner.breadcrumb.map((crumb) => crumb.id),
      [shared, nested],
    );
    for (const outside of [parent, sibling, elsewhere]) {
      assert.equal(yield* reason(shares.page(token, outside)), "unavailable");
    }
    assert.equal(yield* reason(shares.page(token, C.SpacePageId.make("missing"))), "unavailable");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("counts a viewer opening a page without naming it", () =>
  Effect.gen(function* () {
    const { shares, rootPage, credentialOf } = yield* workspace();
    const shared = yield* rootPage("Private title");
    yield* Ref.set(recorded, []);
    const token = credentialOf((yield* shares.create({ pageId: shared })).url);
    assert.deepEqual(yield* Ref.get(recorded), []);
    yield* shares.page(token);
    yield* shares.page(token, C.SpacePageId.make("missing")).pipe(Effect.ignore);
    assert.deepEqual(yield* Ref.get(recorded), [
      { event: "feature.used", feature: "page_share.view" },
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("follows pages moved out of and into the tree", () =>
  Effect.gen(function* () {
    const { shares, rootPage, childPage, move, library, credentialOf } = yield* workspace();
    const shared = yield* rootPage("Shared");
    const nested = yield* childPage(shared, "Nested");
    const outsider = yield* rootPage("Outsider");
    const token = credentialOf((yield* shares.create({ pageId: shared })).url);

    yield* move(
      nested,
      { kind: "root", spaceId: library.defaultSpaceId, beforePageId: null },
      "move-out",
    );
    assert.equal(yield* reason(shares.page(token, nested)), "unavailable");

    yield* move(
      outsider,
      { kind: "child", placement: { pageId: shared, parentId: null, beforeBlockId: null } },
      "move-in",
    );
    assert.equal((yield* shares.page(token, outsider)).page.title, "Outsider");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("ends the link when the root is trashed and hides trashed sub-pages", () =>
  Effect.gen(function* () {
    const { shares, rootPage, childPage, trash, credentialOf } = yield* workspace();
    const shared = yield* rootPage("Shared");
    const nested = yield* childPage(shared, "Nested");
    const token = credentialOf((yield* shares.create({ pageId: shared })).url);

    yield* trash(nested);
    assert.equal(yield* reason(shares.page(token, nested)), "unavailable");
    assert.deepEqual((yield* shares.page(token)).children, []);

    yield* trash(shared);
    assert.equal(yield* reason(shares.page(token)), "inactive");
    assert.equal(yield* reason(shares.page(token, nested)), "inactive");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a new link replaces the old one and stopping ends the link", () =>
  Effect.gen(function* () {
    const { shares, rootPage, credentialOf } = yield* workspace();
    const shared = yield* rootPage("Shared");
    const first = credentialOf((yield* shares.create({ pageId: shared })).url);
    const second = credentialOf((yield* shares.create({ pageId: shared })).url);
    assert.notEqual(first, second);
    assert.equal(yield* reason(shares.page(first)), "inactive");
    assert.equal((yield* shares.page(second)).page.title, "Shared");
    assert.equal((yield* shares.get({ pageId: shared })).link?.url.endsWith(second), true);

    yield* shares.stop({ pageId: shared });
    assert.equal(yield* reason(shares.page(second)), "inactive");
    assert.isNull((yield* shares.get({ pageId: shared })).link);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("expires after seven days", () =>
  Effect.gen(function* () {
    const { shares, rootPage, credentialOf } = yield* workspace();
    const shared = yield* rootPage("Shared");
    const token = credentialOf((yield* shares.create({ pageId: shared })).url);
    yield* TestClock.adjust(Duration.millis(SPACE_PAGE_SHARE_TTL_MS - 1));
    assert.equal((yield* shares.page(token)).page.title, "Shared");
    yield* TestClock.adjust(Duration.millis(1));
    assert.equal(yield* reason(shares.page(token)), "inactive");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("pauses with the Labs setting and with the Connect hostname", () =>
  Effect.gen(function* () {
    const { shares, rootPage, credentialOf } = yield* workspace();
    const settings = yield* Settings.ServerSettingsService;
    const shared = yield* rootPage("Shared");
    const token = credentialOf((yield* shares.create({ pageId: shared })).url);

    yield* settings.updateSettings({ spacesPageSharingEnabled: false });
    assert.equal(yield* reason(shares.page(token)), "inactive");
    assert.equal(yield* reason(shares.create({ pageId: shared })), "disabled");
    yield* shares.stop({ pageId: shared });
    yield* settings.updateSettings({ spacesPageSharingEnabled: true });
    assert.equal(yield* reason(shares.page(token)), "inactive");

    const again = credentialOf((yield* shares.create({ pageId: shared })).url);
    yield* Ref.set(hostname, null);
    assert.equal(yield* reason(shares.page(again)), "inactive");
    assert.equal(yield* reason(shares.create({ pageId: shared })), "connect_unavailable");
    yield* Ref.set(hostname, "other.t2.test");
    assert.equal(yield* reason(shares.page(again)), "inactive");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses forged credentials and unshareable pages", () =>
  Effect.gen(function* () {
    const { shares, rootPage, trash, credentialOf } = yield* workspace();
    const shared = yield* rootPage("Shared");
    const token = credentialOf((yield* shares.create({ pageId: shared })).url);
    const [id] = token.split(".");
    for (const forged of ["", "nope", `${id}.AAAA`, `${id}.`, `${token}.extra`, `x.${token}`]) {
      assert.equal(yield* reason(shares.page(forged)), "invalid");
    }
    yield* trash(shared);
    assert.equal(yield* reason(shares.create({ pageId: shared })), "page_unavailable");
    assert.equal(
      yield* reason(shares.create({ pageId: C.SpacePageId.make("missing") })),
      "page_unavailable",
    );
    assert.isTrue(Exit.isSuccess(yield* Effect.exit(shares.stop({ pageId: shared }))));
  }).pipe(Effect.provide(layerTest)),
);

const decodePage = Schema.decodeUnknownSync(SpaceSharedPage);
const jsonOf = (response: Response) => Effect.promise(() => response.json());
const decodeFailure = Schema.decodeUnknownSync(Schema.Struct({ reason: Schema.String }));
const failureReason = (response: Response) =>
  Effect.promise(async () => decodeFailure(await response.json()).reason);
const pdf = new TextEncoder().encode("%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n");

const httpHarness = Effect.fn("PageShareTest.httpHarness")(function* () {
  const context = yield* Effect.context<
    PageShareService.SpacePageShareService | FileSystem.FileSystem | HttpPlatform.HttpPlatform
  >();
  const { handler, dispose } = HttpRouter.toWebHandler(
    PageShareHttp.layer.pipe(Layer.provide(Layer.succeedContext(context))),
    { disableLogger: true },
  );
  yield* Effect.addFinalizer(() => Effect.promise(dispose));
  const get = (relative: string) =>
    Effect.promise(() => handler(new Request(`http://t2.test${relative}`), context));
  const pageUrl = (token: string, page?: string) =>
    `${SPACE_PAGE_SHARE_PAGE_ROUTE}?share=${encodeURIComponent(token)}${page === undefined ? "" : `&page=${encodeURIComponent(page)}`}`;
  const assetUrl = (token: string, id: string, page?: string) =>
    `${SPACE_PAGE_SHARE_ASSET_ROUTE}?share=${encodeURIComponent(token)}&id=${encodeURIComponent(id)}${page === undefined ? "" : `&page=${encodeURIComponent(page)}`}`;
  return { get, pageUrl, assetUrl };
});

const uploadPdf = Effect.fn("PageShareTest.uploadPdf")(function* (
  spaces: SpacesService.SpacesService["Service"],
  requestId: string,
) {
  const minted = yield* spaces.createAssetUpload(
    {
      environmentId,
      requestId,
      expectedBytes: pdf.length,
      mediaKind: "pdf",
      mimeType: "application/pdf",
      name: "report.pdf",
    },
    "owner",
  );
  yield* spaces.receiveAssetUpload(
    minted.relativeUrl.split("/").at(-1)!,
    String(pdf.length),
    Stream.make(new Uint8Array(pdf)),
  );
  return yield* spaces.finalizeAssetUpload({ environmentId, uploadId: minted.uploadId }, "owner");
});

it.effect("serves the page route as JSON with no caching and refuses everything else", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { shares, rootPage, childPage, write, trash, credentialOf } = yield* workspace();
      const { get, pageUrl } = yield* httpHarness();
      const parent = yield* rootPage("Parent");
      const shared = yield* childPage(parent, "Shared");
      const nested = yield* childPage(shared, "Nested");
      const elsewhere = yield* rootPage("Elsewhere");
      yield* write(shared, "intro", "hello viewers");
      const token = credentialOf((yield* shares.create({ pageId: shared })).url);

      const root = yield* get(pageUrl(token));
      assert.equal(root.status, 200);
      assert.equal(root.headers.get("cache-control"), "no-store");
      const body = decodePage(yield* jsonOf(root));
      assert.equal(body.page.title, "Shared");
      assert.deepEqual(
        body.children.map((child) => child.id),
        [nested],
      );

      const inner = decodePage(yield* jsonOf(yield* get(pageUrl(token, nested))));
      assert.deepEqual(
        inner.breadcrumb.map((crumb) => crumb.title),
        ["Shared", "Nested"],
      );

      for (const outside of [parent, elsewhere]) {
        const refused = yield* get(pageUrl(token, outside));
        assert.equal(refused.status, 403);
        assert.equal(refused.headers.get("cache-control"), "no-store");
        assert.equal(yield* failureReason(refused), "unavailable");
      }
      const forged = yield* get(pageUrl(`${token}x`));
      assert.equal(forged.status, 403);
      assert.equal(yield* failureReason(forged), "invalid");
      assert.equal((yield* get(pageUrl(""))).status, 400);
      assert.equal((yield* get(`${SPACE_PAGE_SHARE_PAGE_ROUTE}`)).status, 400);

      yield* trash(shared);
      const ended = yield* get(pageUrl(token));
      assert.equal(ended.status, 403);
      assert.equal(yield* failureReason(ended), "inactive");
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("stops serving a replaced, stopped or expired link", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { shares, rootPage, credentialOf } = yield* workspace();
      const { get, pageUrl } = yield* httpHarness();
      const shared = yield* rootPage("Shared");
      const first = credentialOf((yield* shares.create({ pageId: shared })).url);
      const second = credentialOf((yield* shares.create({ pageId: shared })).url);
      assert.equal((yield* get(pageUrl(first))).status, 403);
      assert.equal((yield* get(pageUrl(second))).status, 200);
      yield* shares.stop({ pageId: shared });
      assert.equal((yield* get(pageUrl(second))).status, 403);

      const third = credentialOf((yield* shares.create({ pageId: shared })).url);
      yield* TestClock.adjust(Duration.millis(SPACE_PAGE_SHARE_TTL_MS));
      assert.equal((yield* get(pageUrl(third))).status, 403);
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("serves only assets that a live block of the requested page references", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { spaces, shares, rootPage, childPage, credentialOf } = yield* workspace();
      const { get, assetUrl } = yield* httpHarness();
      const shared = yield* rootPage("Shared");
      const nested = yield* childPage(shared, "Nested");
      const outside = yield* rootPage("Outside");
      const used = yield* uploadPdf(spaces, "used");
      const foreign = yield* uploadPdf(spaces, "foreign");
      const orphan = yield* uploadPdf(spaces, "orphan");
      const library = yield* spaces.listSpaces(env);
      const attach = Effect.fn("PageShareTest.attach")(function* (
        pageId: C.SpacePageId,
        blockId: string,
        assetId: C.SpaceAssetId,
      ) {
        const page = yield* spaces.getPage({ ...env, pageId });
        yield* spaces.applyBlockBatch({
          ...env,
          receiptEpoch: library.mutationAdmission.epoch,
          mutationId: `attach-${blockId}`,
          pageId,
          baseRevision: page.page.revision,
          generation: 0,
          mutations: [
            {
              kind: "insert",
              block: {
                id: C.SpaceBlockId.make(blockId),
                parentId: null,
                order: "00000000000000000000000000000001",
                type: "pdf",
                version: 1,
                content: { assetId },
              },
            },
          ],
        });
      });
      yield* attach(shared, "used-block", used.assetId);
      yield* attach(outside, "foreign-block", foreign.assetId);
      const token = credentialOf((yield* shares.create({ pageId: shared })).url);

      const served = yield* get(assetUrl(token, used.assetId));
      assert.equal(served.status, 200);
      assert.equal(served.headers.get("cache-control"), "no-store");
      assert.equal(served.headers.get("content-security-policy"), "default-src 'none'; sandbox");
      assert.deepEqual(new Uint8Array(yield* Effect.promise(() => served.arrayBuffer())), pdf);

      const refused = [
        assetUrl(token, foreign.assetId),
        assetUrl(token, foreign.assetId, outside),
        assetUrl(token, orphan.assetId),
        assetUrl(token, used.assetId, nested),
        assetUrl(token, used.assetId, outside),
        assetUrl(`${token}x`, used.assetId),
      ];
      for (const url of refused) {
        const response = yield* get(url);
        assert.equal(response.status, 403, url);
        assert.equal(response.headers.get("cache-control"), "no-store");
      }
      assert.equal((yield* get(`${SPACE_PAGE_SHARE_ASSET_ROUTE}?share=${token}`)).status, 400);

      yield* shares.stop({ pageId: shared });
      assert.equal((yield* get(assetUrl(token, used.assetId))).status, 403);
    }),
  ).pipe(Effect.provide(layerTest)),
);
