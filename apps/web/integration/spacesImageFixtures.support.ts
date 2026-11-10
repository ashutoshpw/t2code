import { WS_METHODS } from "@t2code/contracts";
import * as Schema from "effect/Schema";
import * as C from "@t2code/contracts/spaces";
import {
  SpaceImageUploads,
  decodeSpaceImageRecord,
  mediaAssetId,
  type SpaceImageRecord,
  type SpaceImageStore,
  createSpaceServiceSessionAdapter,
  type SpaceDocumentDraft,
  decodeSpaceDocumentDraft,
} from "@t2code/client-runtime/spaces";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpRouter } from "effect/http";
import * as ServerHttp from "../../server/src/http.ts";
import * as Clock from "effect/Clock";
import * as SpacesService from "../../server/src/spaces/SpacesService.ts";
import { SpaceDocumentController } from "../src/spaces/documentController.ts";
import { boot, signal } from "./spacesEditorBridge.support.ts";
import { encodedRootRpc } from "./spacesServiceFixtures.support.ts";

const decodeImageBatch = Schema.decodeUnknownSync(C.SpaceApplyBlockBatchResult);
const decodeImageMetadata = Schema.decodeUnknownSync(C.SpaceAssetMetadata);
const decodeImageGrant = Schema.decodeUnknownSync(C.SpaceAssetUploadCreateResult);
const decodeImageStatus = Schema.decodeUnknownSync(C.SpaceAssetUploadStatus);

export const pdfBytes = new TextEncoder().encode(
  "%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n",
);

export const videoBytes = new Uint8Array([
  0,
  0,
  0,
  24,
  ...new TextEncoder().encode("ftypisom"),
  0,
  0,
  0,
  0,
  ...new TextEncoder().encode("isommp42"),
  0,
  0,
  0,
  8,
  ...new TextEncoder().encode("mdat"),
]);

export const imageBytes = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 4, 0, 0,
  0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 252, 255, 31, 0, 3, 3, 2, 0, 239,
  191, 151, 219, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
]);

export const imageWorkflowFixture = Effect.fn("SpaceImageWorkflowTest.fixture")(function* (
  service: SpacesService.SpacesService["Service"],
  databasePath: string,
) {
  const h = yield* boot(service);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "editor-image-originals-" });
  const rpcA = yield* encodedRootRpc(service, "image-caller-a"),
    rpcB = yield* encodedRootRpc(service, "image-caller-b");
  const context = yield* Effect.context<
    | SpacesService.SpacesService
    | import("../../server/src/auth/ServerSecretStore.ts").ServerSecretStore
  >();
  const clock = yield* Clock.Clock;
  const http = HttpRouter.toWebHandler(
    ServerHttp.layerSpacesUploadRoute.pipe(
      Layer.provideMerge(
        Layer.mergeAll(Layer.succeedContext(context), Layer.succeed(Clock.Clock, clock)),
      ),
    ),
    { disableLogger: true },
  );
  yield* Effect.addFinalizer(() => Effect.promise(http.dispose));
  const control = {
    session: {},
    caller: "a",
    read: true,
    operate: true,
    loseMint: false,
    losePost: false,
    loseFinalize: false,
    failPhase: "",
    failDraft: false,
    holdDocument: false,
    holdMetadata: false,
    metadataEntered: signal(),
    metadataReply: signal(),
    loseDocument: false,
    committed: signal(),
    documentReply: signal(),
    holdPhase: "",
    entered: signal(),
    release: signal(),
  };
  let mintCalls = 0,
    posts = 0,
    ids = 0;
  const documentRequests: C.SpaceApplyBlockBatchInput[] = [];
  const location = (slot: number) => path.join(directory, `original-${slot}`);
  async function load(): Promise<readonly SpaceImageRecord[]> {
    const records: SpaceImageRecord[] = [];
    for (const slot of [0, 1]) {
      if (!(await h.run(fs.exists(location(slot))))) continue;
      const bytes = await h.run(fs.readFile(location(slot)));
      const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
      const metadata = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length))) as Omit<
        SpaceImageRecord,
        "original"
      >;
      records.push(
        decodeSpaceImageRecord({
          ...metadata,
          original: new Blob([bytes.slice(4 + length)], { type: metadata.intent.mimeType }),
        }),
      );
    }
    return records;
  }
  const originals: SpaceImageStore = {
    load,
    put: async (input, expected) => {
      const record = decodeSpaceImageRecord(input),
        all = await load();
      const previous = all.find((r) => r.slot === record.slot);
      if (
        expected === null ? previous : previous?.id !== record.id || previous.sequence !== expected
      )
        throw new Error("Changed original");
      if (control.holdPhase === record.phase) {
        control.holdPhase = "";
        control.entered.resolve();
        await control.release.promise;
      }
      if (control.failPhase === record.phase) {
        control.failPhase = "";
        throw new Error("Original persistence failed");
      }
      const { original, ...metadata } = record;
      const json = new TextEncoder().encode(JSON.stringify(metadata)),
        blob = new Uint8Array(await original.arrayBuffer());
      const bytes = new Uint8Array(4 + json.length + blob.length);
      new DataView(bytes.buffer).setUint32(0, json.length);
      bytes.set(json, 4);
      bytes.set(blob, 4 + json.length);
      await h.run(fs.writeFile(`${location(record.slot)}.tmp`, bytes));
      await h.run(fs.rename(`${location(record.slot)}.tmp`, location(record.slot)));
    },
    remove: async (record) => {
      if (control.holdPhase === "release") {
        control.holdPhase = "";
        control.entered.resolve();
        await control.release.promise;
      }
      const previous = (await load()).find((r) => r.slot === record.slot);
      if (previous?.id !== record.id || previous.sequence !== record.sequence)
        throw new Error("Changed original");
      await h.run(fs.remove(location(record.slot)));
    },
  };
  const draftPath = path.join(directory, "page-draft.json");
  const drafts = {
    load: async (key: C.SpacePageTarget) =>
      (await h.run(fs.exists(draftPath)))
        ? decodeSpaceDocumentDraft(JSON.parse(await h.run(fs.readFileString(draftPath))), key)
        : null,
    write: async (key: C.SpacePageTarget, value: SpaceDocumentDraft | null) => {
      const decoded = value === null ? null : decodeSpaceDocumentDraft(value, key);
      if (control.failDraft && decoded?.blocks.some((b) => mediaAssetId(b)))
        throw new Error("Page draft persistence failed");
      if (decoded === null) {
        if (await h.run(fs.exists(draftPath))) await h.run(fs.remove(draftPath));
      } else {
        await h.run(fs.writeFileString(`${draftPath}.tmp`, JSON.stringify(decoded)));
        await h.run(fs.rename(`${draftPath}.tmp`, draftPath));
      }
    },
  };
  const rpc = (tag: string, input: unknown) =>
    h.run((control.caller === "a" ? rpcA : rpcB)(tag, input));
  const metadata = async (input: C.SpaceAssetGetInput) => {
    const result = decodeImageMetadata(await rpc(WS_METHODS.spacesAssetsGet, input));
    if (control.holdMetadata) {
      control.holdMetadata = false;
      control.metadataEntered.resolve();
      await control.metadataReply.promise;
    }
    return result;
  };
  const make = () =>
    new SpaceImageUploads({
      store: originals,
      draft: drafts.load,
      newId: () => `image-original-${++ids}`,
      changed: () => {},
      access: (_environmentId, write) => {
        if (!control.read || (write && !control.operate))
          throw new Error("Image permission withdrawn");
        return { session: control.session, limits: h.capability.limits.assets! };
      },
      metadata,
      mint: async (input) => {
        mintCalls++;
        const value = decodeImageGrant(await rpc(WS_METHODS.spacesAssetsUploadCreate, input));
        if (control.loseMint) {
          control.loseMint = false;
          throw new Error("Lost mint reply");
        }
        return value;
      },
      status: async (input) =>
        decodeImageStatus(await rpc(WS_METHODS.spacesAssetsUploadGet, input)),
      finalize: async (input) => {
        const result = decodeImageMetadata(await rpc(WS_METHODS.spacesAssetsUploadFinalize, input));
        if (control.loseFinalize) {
          control.loseFinalize = false;
          throw new Error("Lost finalize reply");
        }
        return result;
      },
      post: (_environmentId, relativeUrl, original) => {
        posts++;
        const abort = new AbortController();
        return {
          abort: () => abort.abort(),
          done: h.run(
            Effect.promise(async () => {
              const response = await http.handler(
                new Request(`http://images.test${relativeUrl}`, {
                  method: "POST",
                  headers: {
                    "Content-Length": String(original.size),
                    "Content-Type": original.type,
                  },
                  body: original,
                  signal: abort.signal,
                }),
              );
              if (response.status !== 204)
                throw new Error(`Image HTTP rejected: ${response.status} ${await response.text()}`);
              if (control.losePost) {
                control.losePost = false;
                throw new Error("Lost byte POST reply");
              }
            }),
          ),
        };
      },
      saved: async (key, blockId, assetId) => {
        const page = await h.ports.getPage(key);
        const window = await h.run(
          service.readBlocks({ ...key, revision: page.page.revision, limit: 100 }),
        );
        return window.blocks.some((b) => b.id === blockId && mediaAssetId(b) === assetId);
      },
    });
  let images = make();
  const createController = (windowLimit = 100) =>
    new SpaceDocumentController(
      h.key,
      {
        adapter: createSpaceServiceSessionAdapter(h.key, {
          ...h.ports,
          applyBlockBatch: async (input) => {
            documentRequests.push(input);
            const result = decodeImageBatch(await rpc(WS_METHODS.spacesBlocksApply, input));
            if (control.holdDocument) {
              control.holdDocument = false;
              control.committed.resolve();
              await control.documentReply.promise;
            }
            if (control.loseDocument) {
              control.loseDocument = false;
              throw new Error("Lost image document acknowledgement");
            }
            return result;
          },
          validateNewRequest: (request) =>
            request.mutations.some((m) => m.kind !== "delete" && mediaAssetId(m.block))
              ? images.validateNewRequest(request)
              : undefined,
        }),
        assertMutable: () => images.assertMutable(h.key),
        drafts,
        createMutationId: () => `image-document-${++ids}`,
        maxLoadedBlocks: 100,
        maxMutations: 100,
      },
      {
        beforeRead: () => images.hydrate(),
        getPage: () => h.ports.getPage(h.key),
        mediaBlocked: () => images.isBlocked(h.key),
        readBlocks: (input) => h.run(service.readBlocks(input)),
        windowLimit: () => windowLimit,
      },
    );
  return {
    ...h,
    originals,
    drafts,
    control,
    metadata,
    createController,
    databasePath,
    get images() {
      return images;
    },
    reload: () => {
      images = make();
      return images;
    },
    counts: () => ({ mintCalls, posts }),
    documentRequests,
    file: (kind: "image" | "pdf" | "video" = "image") =>
      new Blob([kind === "image" ? imageBytes : kind === "pdf" ? pdfBytes : videoBytes], {
        type: kind === "image" ? "image/png" : kind === "pdf" ? "application/pdf" : "video/mp4",
      }),
  };
});
