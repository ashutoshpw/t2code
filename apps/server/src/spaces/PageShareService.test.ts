import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, SPACE_PAGE_SHARE_TTL_MS } from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CloudManagedEndpointRuntime } from "../cloud/ManagedEndpointRuntime.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Settings from "../serverSettings.ts";
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
const layerTest = PageShareService.layer.pipe(
  Layer.provideMerge(layerSpaces),
  Layer.provide(layerConnect),
  Layer.provide(ServerSecretStore.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "page-share-" })),
  Layer.provideMerge(NodeServices.layer),
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
