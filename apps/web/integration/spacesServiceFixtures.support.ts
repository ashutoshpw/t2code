import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  WS_METHODS,
} from "@t2code/contracts";
import * as Schema from "effect/Schema";
import * as C from "@t2code/contracts/spaces";
import {
  SpaceReferenceController,
  SpaceImageUploads,
  type SpaceReferenceAccess,
  createSpaceServiceSessionAdapter,
  type SpaceDocumentDraft,
  SpaceRootReorder,
  decodeSpaceStructureJournal,
  checkSpaceStructureDrafts,
  type SpaceStructureJournal,
  decodeSpaceDocumentDraft,
} from "@t2code/client-runtime/spaces";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as SpacesRpc from "../../server/src/spaces/Rpc.ts";
import * as RpcAuthorization from "../../server/src/auth/RpcAuthorization.ts";
import { WS_RPC_SERVER_OPTIONS } from "../../server/src/ws.ts";
import * as RpcMessage from "effect/rpc/RpcMessage";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import * as SpacesService from "../../server/src/spaces/SpacesService.ts";
import {
  SpaceDocumentController,
  SpaceDocumentControllers,
} from "../src/spaces/documentController.ts";
import {
  environmentId,
  boot,
  queryRuntime,
  signal,
  savedParagraph,
} from "./spacesEditorBridge.support.ts";

const decodeStructureServiceError = Schema.decodeUnknownOption(C.SpaceServiceError);
const decodeBlockMoveResult = Schema.decodeUnknownSync(C.SpaceMoveBlocksResult);
const decodeMoveSpaces = Schema.decodeUnknownSync(C.SpaceListResult);
const decodeMoveBody = Schema.decodeUnknownSync(C.SpaceReadBlocksResult);
const decodeRootList = Schema.decodeUnknownSync(C.SpacePageListResult);
const decodeRootInspect = Schema.decodeUnknownSync(C.SpaceInspectStructureResult);
const decodeRootRequest = Schema.decodeUnknownSync(C.SpaceMutationRequest, {
  onExcessProperty: "error",
});
const decodeRootResult = Schema.decodeUnknownSync(C.SpaceMovePageResult, {
  onExcessProperty: "error",
});
const decodeChildResult = Schema.decodeUnknownSync(C.SpaceCreateChildPageResult);
const decodePurgeResult = Schema.decodeUnknownSync(C.SpacePagePurgeResult);
const decodeRecoveryResult = Schema.decodeUnknownSync(C.SpacePageRecoveryResult);
const decodeTrashList = Schema.decodeUnknownSync(C.SpaceTrashListResult);
const decodeLibraryReceipt = Schema.decodeUnknownSync(C.SpaceMutationReceipt);
const decodeRootReceipt = Schema.decodeUnknownSync(C.SpaceReceiptLookupResult);
const decodeSourceSearch = Schema.decodeUnknownSync(C.SpaceSearchResult);
const decodeSourceResolve = Schema.decodeUnknownSync(C.SpaceReferenceResolveResult);

export const encodedRootRpc = Effect.fn("SpaceEditorServiceTest.encodedRootRpc")(function* (
  service: SpacesService.SpacesService["Service"],
  callerId = "editor-integration",
) {
  const responses = yield* Queue.unbounded<string | Uint8Array>();
  const receive = yield* Deferred.make<Parameters<RpcServer.Protocol["Service"]["run"]>[0]>();
  const parser = RpcSerialization.json.makeUnsafe();
  const protocol = yield* RpcServer.Protocol.make((send) =>
    Effect.gen(function* () {
      yield* Deferred.succeed(receive, send);
      return {
        disconnects: yield* Queue.unbounded<number>(),
        send: (_id, response) => Queue.offer(responses, parser.encode(response)!),
        end: () => Effect.void,
        clientIds: Effect.succeed(new Set([0])),
        initialMessage: Effect.succeedNone,
        supportsAck: true,
        supportsTransferables: false,
        supportsSpanPropagation: false,
        supportsNotifications: true,
        codecFor: RpcSerialization.json.codecFor,
      };
    }),
  );
  const handlers = yield* SpacesRpc.handlers(callerId).pipe(
    Effect.provideService(SpacesService.SpacesService, service),
  );
  const context = yield* SpacesRpc.group.toHandlers(handlers);
  yield* RpcServer.make(SpacesRpc.group, WS_RPC_SERVER_OPTIONS).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeedContext(context),
        Layer.succeed(RpcServer.Protocol, protocol),
        RpcAuthorization.layer([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]),
      ),
    ),
    Effect.forkScoped,
  );
  const write = yield* Deferred.await(receive);
  let sequence = 0;
  return Effect.fn("SpaceEditorServiceTest.encodedRootRequest")(function* (
    tag: string,
    payload: unknown,
  ) {
    const frame = parser.encode({
      _tag: "Request",
      id: String(++sequence),
      tag,
      payload,
      headers: [],
    })!;
    for (const message of parser.decode(frame))
      yield* write(0, message as RpcMessage.FromClientEncoded);
    const response = parser.decode(yield* Queue.take(responses))[0] as RpcMessage.FromServerEncoded;
    if (response._tag !== "Exit" || response.exit._tag !== "Success") {
      if (response._tag === "Exit" && response.exit._tag === "Failure")
        for (const cause of response.exit.cause) {
          if (cause._tag === "Fail") {
            const decoded = decodeStructureServiceError(cause.error);
            if (Option.isSome(decoded)) throw decoded.value;
          }
        }
      throw new Error(JSON.stringify(response));
    }
    return response.exit.value;
  });
});

export const rootReorderFixture = Effect.fn("SpaceEditorServiceTest.rootReorder")(function* (
  service: SpacesService.SpacesService["Service"],
) {
  const h = yield* boot(service);
  const pages = [h.key.pageId];
  for (const title of ["Second", "Third", "Fourth"]) {
    const current = yield* service.getPage(h.key);
    const created = yield* service.createPage({
      environmentId,
      spaceId: current.space.id,
      title,
      mutationId: C.SpaceMutationId.make(`root-${title}`),
      receiptEpoch: current.mutationAdmission.epoch,
      baseRootOrderRevision: current.space.rootOrderRevision,
    });
    if (created.status !== "saved") throw new Error("Root fixture conflict");
    pages.push(created.page.id);
  }
  const initial = yield* service.getPage(h.key);
  const rpc = yield* encodedRootRpc(service);
  let stored: SpaceStructureJournal | null = null;
  let ids = 0,
    admissions = 0,
    rows = 50,
    writable = true,
    refreshed = 0,
    maxBytes = h.capability.limits.maxMutationBytes,
    blockFeature = true;
  const libraryRequests: C.SpaceMutationRequest[] = [];
  const childRequests: C.SpaceCreateChildPageInput[] = [];
  const recoveryRequests: C.SpaceMutationRequest[] = [];
  const blockRequests: C.SpaceMoveBlocksInput[] = [];
  const requests: C.SpaceMovePageInput[] = [],
    lookups: C.SpaceReceiptLookupInput[] = [];
  const disk = { fail: false, hold: false, started: signal(), release: signal() };
  const network = {
    lose: null as "before" | "after" | null,
    after: null as (() => Promise<void>) | null,
    rewritePurgeReply: null as ((reply: C.SpacePagePurgeResult) => C.SpacePagePurgeResult) | null,
    rewriteChildReply: null as
      | ((reply: C.SpaceCreateChildPageResult) => C.SpaceCreateChildPageResult)
      | null,
  };
  const documentReads = { failNext: false, attempted: [] as C.SpacePageId[] };
  const structureBodyReads: C.SpacePageId[] = [];
  const draftRecords = new Map<string, SpaceDocumentDraft>();
  const drafts = {
    load: async (key: C.SpacePageTarget) => {
      const value = draftRecords.get(key.pageId);
      return value ? decodeSpaceDocumentDraft(value, key) : null;
    },
    write: async (key: C.SpacePageTarget, draft: SpaceDocumentDraft | null) => {
      if (draft) draftRecords.set(key.pageId, decodeSpaceDocumentDraft(draft, key));
      else draftRecords.delete(key.pageId);
    },
  };
  const makeDocuments = () =>
    new SpaceDocumentControllers(
      (key) =>
        new SpaceDocumentController(
          key,
          {
            adapter: createSpaceServiceSessionAdapter(key, h.ports),
            drafts,
            createMutationId: () => `content-${++ids}`,
            maxLoadedBlocks: 100,
            maxMutations: 100,
          },
          {
            getPage: () => h.ports.getPage(key),
            windowLimit: () => 100,
            readBlocks: (input) => {
              documentReads.attempted.push(input.pageId);
              if (documentReads.failNext) {
                documentReads.failNext = false;
                return Promise.reject(new Error("Controlled first refresh failure"));
              }
              return h.run(service.readBlocks(input));
            },
          },
        ),
    );
  let documents = makeDocuments();
  const make = (changed = () => {}, media?: SpaceImageUploads) =>
    new SpaceRootReorder(environmentId, {
      store: {
        load: async () => stored,
        write: async (env, journal) => {
          const encoded = JSON.parse(JSON.stringify(journal)) as unknown;
          const value = decodeSpaceStructureJournal(encoded, env);
          if (disk.hold) {
            disk.started.resolve();
            await disk.release.promise;
          }
          if (disk.fail) throw new Error("Controlled transaction abort");
          stored = value;
        },
      },
      spaces: async (input) => decodeMoveSpaces(await h.run(rpc(WS_METHODS.spacesList, input))),
      blocks: async (input) => {
        structureBodyReads.push(input.pageId);
        return decodeMoveBody(await h.run(rpc(WS_METHODS.spacesBlocksRead, input)));
      },
      list: async (input) => decodeRootList(await h.run(rpc(WS_METHODS.spacesPagesList, input))),
      inspect: async (input) =>
        decodeRootInspect(await h.run(rpc(WS_METHODS.spacesStructureInspect, input))),
      getPage: (pageId) => {
        admissions++;
        return h.ports.getPage({ environmentId, pageId });
      },
      move: async (input) => {
        // Exercise the strict wire envelope as well as the real SQLite service.
        const request = decodeRootRequest(
          JSON.parse(JSON.stringify({ operation: "movePage", input })),
        );
        if (request.operation !== "movePage") throw new Error("Wrong wire operation");
        requests.push(request.input);
        const lose = network.lose;
        network.lose = null;
        if (lose === "before") throw new Error("Lost before server received request");
        const result = await h.run(rpc(WS_METHODS.spacesPagesMove, request.input));
        if (network.after) {
          const after = network.after;
          network.after = null;
          await after();
        }
        if (lose === "after") throw new Error("Lost committed response");
        return decodeRootResult(JSON.parse(JSON.stringify(result)));
      },
      receipt: async (input) => {
        lookups.push(input);
        return decodeRootReceipt(await h.run(rpc(WS_METHODS.spacesReceiptsGet, input)));
      },
      assertAccess: (write) => {
        if (write && !writable) throw new Error("Operate revoked");
      },
      maxMutationBytes: () => maxBytes,
      maxRows: () => rows,
      capability: () => (blockFeature ? h.capability : { version: 2, limits: h.capability.limits }),
      moveBlocks: async (input) => {
        const request = decodeRootRequest(
          JSON.parse(JSON.stringify({ operation: "moveBlocks", input })),
        );
        if (request.operation !== "moveBlocks") throw new Error("Wrong block-move operation");
        blockRequests.push(request.input);
        const lose = network.lose;
        network.lose = null;
        if (lose === "before") throw new Error("Lost before server received request");
        const result = await h.run(rpc(WS_METHODS.spacesBlocksMove, request.input));
        if (network.after) {
          const after = network.after;
          network.after = null;
          await after();
        }
        if (lose === "after") throw new Error("Lost committed response");
        return decodeBlockMoveResult(result);
      },
      libraryAccess: (write: boolean) => {
        if (write && !writable) throw new Error("Operate revoked");
      },
      library: async (request: import("@t2code/client-runtime/spaces").SpaceLibraryRequest) => {
        const wire = decodeRootRequest(JSON.parse(JSON.stringify(request)));
        libraryRequests.push(wire);
        const tags = {
          createSpace: WS_METHODS.spacesCreate,
          renameSpace: WS_METHODS.spacesRename,
          setDefaultSpace: WS_METHODS.spacesSetDefault,
          createPage: WS_METHODS.spacesPagesCreate,
          updatePage: WS_METHODS.spacesPagesUpdate,
        };
        const lose = network.lose;
        network.lose = null;
        if (lose === "before") throw new Error("Lost before server received request");
        const result = await h.run(rpc(tags[request.operation], wire.input));
        if (network.after) {
          const after = network.after;
          network.after = null;
          await after();
        }
        if (lose === "after") throw new Error("Lost committed response");
        const receipt = decodeLibraryReceipt({ operation: request.operation, result });
        if (
          receipt.operation !== "createSpace" &&
          receipt.operation !== "renameSpace" &&
          receipt.operation !== "setDefaultSpace" &&
          receipt.operation !== "createPage" &&
          receipt.operation !== "updatePage"
        )
          throw new Error("Wrong library receipt");
        return receipt;
      },
      createChild: async (input: C.SpaceCreateChildPageInput) => {
        childRequests.push(input);
        const request = decodeRootRequest(
          JSON.parse(JSON.stringify({ operation: "createChildPage", input })),
        );
        const lose = network.lose;
        network.lose = null;
        if (lose === "before") throw new Error("Lost before server received request");
        const result = await h.run(rpc(WS_METHODS.spacesPagesCreateChild, request.input));
        if (network.after) {
          const after = network.after;
          network.after = null;
          await after();
        }
        if (lose === "after") throw new Error("Lost committed response");
        const decoded = decodeChildResult(result);
        return network.rewriteChildReply ? network.rewriteChildReply(decoded) : decoded;
      },
      trashList: async (input: C.SpaceTrashListInput) =>
        decodeTrashList(await h.run(rpc(WS_METHODS.spacesTrashList, input))),
      purge: async (input: C.SpacePageRecoveryInput) => {
        const request = decodeRootRequest(
          JSON.parse(JSON.stringify({ operation: "permanentlyDeletePage", input })),
        );
        recoveryRequests.push(request);
        const lose = network.lose;
        network.lose = null;
        if (lose === "before") throw new Error("Lost before server received request");
        const result = await h.run(rpc(WS_METHODS.spacesPagesPermanentlyDelete, request.input));
        if (lose === "after") throw new Error("Lost committed response");
        const decoded = decodePurgeResult(result);
        return network.rewritePurgeReply ? network.rewritePurgeReply(decoded) : decoded;
      },
      recovery: async (operation: "trashPage" | "restorePage", input: C.SpacePageRecoveryInput) => {
        const request = decodeRootRequest(JSON.parse(JSON.stringify({ operation, input })));
        recoveryRequests.push(request);
        const lose = network.lose;
        network.lose = null;
        if (lose === "before") throw new Error("Lost before server received request");
        const result = await h.run(
          rpc(
            operation === "trashPage" ? WS_METHODS.spacesPagesTrash : WS_METHODS.spacesPagesRestore,
            request.input,
          ),
        );
        if (lose === "after") throw new Error("Lost committed response");
        return decodeRecoveryResult(result);
      },
      newId: () => `placement-${++ids}`,
      reserve: (pages, restoring) => {
        const releaseMedia = media?.reserve(environmentId, pages);
        try {
          const release = documents.reserve(environmentId, pages, restoring);
          return () => {
            release();
            releaseMedia?.();
          };
        } catch (error) {
          releaseMedia?.();
          throw error;
        }
      },
      checkDrafts: async (pages) => {
        await media?.checkPages(environmentId, pages);
        await checkSpaceStructureDrafts(drafts, environmentId, pages);
      },
      refresh: async (pages) => {
        refreshed++;
        await documents.refreshStructure(environmentId, pages);
      },
      changed,
    });
  return {
    ...h,
    pages,
    spaceId: initial.space.id,
    make,
    documents,
    drafts,
    draftRecords,
    documentReads,
    structureBodyReads,
    requests,
    lookups,
    disk,
    network,
    counts: () => ({ admissions, refreshed }),
    stored: () => stored,
    blockRequests,
    childRequests,
    libraryRequests,
    recoveryRequests,
    setBlockFeature: (value: boolean) => {
      blockFeature = value;
    },
    setMaxBytes: (value: number) => {
      maxBytes = value;
    },
    setRows: (value: number) => {
      rows = value;
    },
    setWritable: (value: boolean) => {
      writable = value;
    },
    reload: () => {
      documents = makeDocuments();
      return make();
    },
    order: async () =>
      (await h.run(service.listPages({ environmentId, spaceId: initial.space.id }))).items.map(
        (p) => p.id,
      ),
  };
});

export const nestedMoveFixture = Effect.fn("SpaceEditorServiceTest.nestedMoves")(function* (
  service: SpacesService.SpacesService["Service"],
) {
  const h = yield* rootReorderFixture(service);
  let serial = 0;
  const child = Effect.fn("SpaceEditorServiceTest.child")(function* (
    parent: C.SpacePageId,
    parentId: C.SpaceBlockId | null = null,
  ) {
    const placement = { pageId: parent, parentId, beforeBlockId: null };
    const inspected = yield* service.inspectStructure({
      environmentId,
      target: { kind: "blocks", pageId: parent, blockIds: [] },
      destination: { kind: "child", placement },
    });
    const admission = yield* service.getPage({ environmentId, pageId: parent });
    const created = yield* service.createChildPage({
      environmentId,
      mutationId: C.SpaceMutationId.make(`nested-move-child-${++serial}`),
      receiptEpoch: admission.mutationAdmission.epoch,
      title: `Child ${serial}`,
      placement,
      guards: inspected.guards,
    });
    if (created.status !== "saved") throw new Error("Unexpected fixture child conflict");
    return created;
  });
  const a = yield* child(h.pages[0]!);
  const descendant = yield* child(a.page.id);
  const b = yield* child(h.pages[1]!);
  const library = yield* service.listSpaces({ environmentId });
  const space = yield* service.createSpace({
    environmentId,
    mutationId: "move-other-space",
    receiptEpoch: library.mutationAdmission.epoch,
    title: "Destination",
  });
  const root = yield* service.createPage({
    environmentId,
    mutationId: "move-other-root",
    receiptEpoch: library.mutationAdmission.epoch,
    spaceId: space.space.id,
    baseRootOrderRevision: 0,
    title: "Other root",
  });
  if (root.status !== "saved") throw new Error("Unexpected fixture root conflict");
  return { ...h, a, b, descendant, other: space.space.id, otherRoot: root.page.id, child };
});

export const blockMoveFixture = Effect.fn("SpaceEditorServiceTest.blockMoves")(function* (
  service: SpacesService.SpacesService["Service"],
) {
  const h = yield* rootReorderFixture(service);
  const page = yield* service.getPage(h.key);
  const blocks = [
    {
      ...savedParagraph("block-list", "Container", "20000000000000000000000000000000"),
      type: "bulleted_item",
    },
    {
      ...savedParagraph("nested-text", "MoveUniqueNeedle", "40000000000000000000000000000000"),
      parentId: C.SpaceBlockId.make("block-list"),
    },
    savedParagraph("block-b", "Second", "80000000000000000000000000000000"),
    savedParagraph("block-c", "Third", "c0000000000000000000000000000000"),
  ];
  yield* service.applyBlockBatch({
    ...h.key,
    mutationId: "seed-block-moves",
    receiptEpoch: page.mutationAdmission.epoch,
    baseRevision: page.page.revision,
    generation: 1,
    mutations: blocks.map((block) => ({ kind: "insert" as const, block })),
  });
  return {
    ...h,
    blocks,
    read: (pageId: C.SpacePageId) =>
      h.run(
        Effect.gen(function* () {
          const metadata = yield* service.getPage({ environmentId, pageId });
          return yield* service.readBlocks({
            environmentId,
            pageId,
            revision: metadata.page.revision,
          });
        }),
      ),
  };
});

export const sourceFixture = Effect.fn("SpaceEditorServiceTest.sources")(function* (
  service: SpacesService.SpacesService["Service"],
) {
  const h = yield* rootReorderFixture(service);
  const rpc = yield* encodedRootRpc(service);
  const q = yield* queryRuntime(h.ports, (input) => h.run(service.readBlocks(input)));
  const changeAtom = q.queries.changed(environmentId);
  const unmount = q.registry.mount(changeAtom);
  yield* Effect.addFinalizer(() => Effect.sync(unmount));
  const access: SpaceReferenceAccess = {
    session: {},
    sourceVersion: 0,
    canRead: true,
    capability: h.capability,
  };
  const control = {
    access,
    searchGate: null as (ReturnType<typeof signal> & { reply: ReturnType<typeof signal> }) | null,
    resolveGate: null as (ReturnType<typeof signal> & { reply: ReturnType<typeof signal> }) | null,
  };
  const searches: C.SpaceSearchInput[] = [],
    resolves: C.SpaceReferenceResolveInput[] = [];
  const make = () =>
    new SpaceReferenceController({
      environmentId,
      access: () => ({ ...control.access, sourceVersion: q.registry.get(changeAtom) }),
      search: async (input) => {
        searches.push(input);
        const gate = control.searchGate;
        control.searchGate = null;
        const result = decodeSourceSearch(await h.run(rpc(WS_METHODS.spacesSearch, input)));
        if (gate) {
          gate.resolve();
          await gate.reply.promise;
        }
        return result;
      },
      resolve: async (input) => {
        resolves.push(input);
        const gate = control.resolveGate;
        control.resolveGate = null;
        const result = decodeSourceResolve(
          await h.run(rpc(WS_METHODS.spacesReferencesResolve, input)),
        );
        if (gate) {
          gate.resolve();
          await gate.reply.promise;
        }
        return result;
      },
    });
  return {
    ...h,
    control,
    searches,
    resolves,
    sources: make(),
    makeSources: make,
    changed: () => q.registry.update(changeAtom, (value) => value + 1),
  };
});
