import { expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "../packages/contracts/src/index.ts";
import { SpacePageId } from "../packages/contracts/src/spaces.ts";
import {
  SpaceDocumentSession,
  createSpaceServiceSessionAdapter,
} from "../packages/client-runtime/src/spaces/index.ts";
import { diskDatabase } from "../apps/mobile/src/persistence/mobile-database.test-support.ts";
import { MobileDatabase } from "../apps/mobile/src/persistence/mobile-database.ts";
import { createMobileSpaceMediaStore } from "../apps/mobile/src/features/spaces/originalStore.ts";
import {
  MobileSpaceOriginalFiles,
  withNativeSpaceOriginals,
} from "../apps/mobile/src/features/spaces/originalFiles.ts";
import { createMobileSpaceUploads } from "../apps/mobile/src/features/spaces/uploads.ts";
import { SpacesPageReader } from "../apps/mobile/src/features/spaces/reader.ts";
import { mobileSpaceImageInsertion } from "../apps/mobile/src/features/spaces/imageInsertion.ts";
import * as Secrets from "../apps/server/src/auth/ServerSecretStore.ts";
import * as WorkspacePaths from "../apps/server/src/workspace/WorkspacePaths.ts";
import * as Config from "../apps/server/src/config.ts";
import * as Identity from "../apps/server/src/environment/ServerEnvironment.ts";
import * as Settings from "../apps/server/src/serverSettings.ts";
import * as Service from "../apps/server/src/spaces/SpacesService.ts";
import { promiseRunner } from "./spaces-mobile.test-support.mjs";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
  "base64",
);
const env = EnvironmentId.make("native-originals");
const key = { environmentId: env, pageId: SpacePageId.make("local-page") };
const limits = {
  maxImageBytes: 10 * 1024 * 1024,
  maxPdfBytes: 25 * 1024 * 1024,
  maxVideoBytes: 50 * 1024 * 1024,
  maxImagePixels: 24000000,
  maxHeaderBytes: 65536,
  maxEnvironmentBytes: 100000000,
  maxPendingPerCaller: 2,
  maxPendingUploads: 8,
  maxActiveUploads: 1,
  uploadTtlMs: 60000,
  recoveryBatchRows: 8,
  recoveryBatchBytes: 1000000,
};
function fileIO(
  directory,
  upload = async () => {
    throw new Error("Unexpected byte transport");
  },
) {
  return {
    uri: (slot, part) => NodePath.join(directory, `original-${slot}${part ? ".part" : ""}`),
    reader: async (uri) => {
      const fd = NodeFS.openSync(uri, "r");
      let offset = 0;
      return {
        read: async (bytes) => {
          const data = Buffer.alloc(bytes);
          const count = NodeFS.readSync(fd, data, 0, bytes, offset);
          offset += count;
          return data.subarray(0, count);
        },
        close: () => NodeFS.closeSync(fd),
      };
    },
    writer: async (uri) => {
      const fd = NodeFS.openSync(uri, "wx");
      return {
        write: async (bytes) => {
          NodeFS.writeSync(fd, bytes);
        },
        close: () => NodeFS.closeSync(fd),
      };
    },
    inspect: async (uri, maxBytes) => {
      const size = NodeFS.statSync(uri).size;
      if (size < 1 || size > maxBytes) throw new Error("File is outside its byte bound");
      const hash = NodeCrypto.createHash("sha256");
      const fd = NodeFS.openSync(uri, "r");
      const chunk = Buffer.alloc(65536);
      try {
        for (;;) {
          const count = NodeFS.readSync(fd, chunk);
          if (!count) break;
          hash.update(chunk.subarray(0, count));
        }
      } finally {
        NodeFS.closeSync(fd);
      }
      return { size, sha256: hash.digest("hex") };
    },
    remove: async (uri) => {
      NodeFS.rmSync(uri, { force: true });
    },
    move: async (source, destination) => {
      if (NodeFS.existsSync(destination)) throw new Error("Refuse overwrite");
      NodeFS.renameSync(source, destination);
    },
    upload,
  };
}
function runtime(open, io, overrides = {}) {
  const context = Context.make(MobileDatabase, open.database);
  const store = createMobileSpaceMediaStore(async () => context);
  let id = 0;
  const unexpected = async () => {
    throw new Error("No remote operation was authorized");
  };
  const session = {};
  return {
    store,
    value: createMobileSpaceUploads({
      store,
      io,
      access: () => ({ session, limits }),
      newId: () => (++id).toString(16).padStart(32, "0"),
      origin: () => "https://environment.example",
      changed: () => {},
      draft: (key) => open.store.load(key),
      saved: async () => false,
      mint: unexpected,
      status: unexpected,
      finalize: unexpected,
      metadata: unexpected,
      ...overrides,
    }),
  };
}

it.effect(
  "commits retained files outside cache, rolls back actual SQL, reopens exact ownership and refuses corrupt bytes without deleting them",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* diskDatabase();
        const opened = yield* fixture.open();
        const directory = NodePath.dirname(fixture.file);
        const selected = NodePath.join(directory, "selected.png");
        NodeFS.writeFileSync(selected, png);
        const io = fileIO(directory);
        const first = runtime(opened, io);
        fixture.control.beforeCommit = async () => {
          throw new Error("injected rollback");
        };
        yield* Effect.promise(async () => {
          await expect(
            first.value.retain(key, selected, "original.png", () => true),
          ).rejects.toThrow();
          expect(await first.store.load()).toEqual([]);
          expect(NodeFS.existsSync(io.uri(0, false))).toBe(false);
        });
        fixture.control.beforeCommit = null;
        yield* Effect.promise(async () => {
          NodeFS.writeFileSync(selected, Buffer.alloc(10 * 1024 * 1024 + 1, 1));
          await expect(
            first.value.retain(key, selected, "too-large.png", () => true),
          ).rejects.toThrow("byte limit");
          expect(await first.store.load()).toEqual([]);
          NodeFS.writeFileSync(selected, "not an image");
          await expect(first.value.retain(key, selected, "wrong.png", () => true)).rejects.toThrow(
            "unchanged",
          );
          expect(await first.store.load()).toEqual([]);
          NodeFS.writeFileSync(selected, png);
        });
        yield* Effect.promise(() => first.value.retain(key, selected, "original.png", () => true));
        const [retained] = yield* Effect.promise(() => first.store.load());
        expect(retained.original.sha256).toBe(
          NodeCrypto.createHash("sha256").update(png).digest("hex"),
        );
        yield* Effect.promise(async () => {
          await expect(
            first.store.put(
              {
                ...retained,
                sequence: retained.sequence + 1,
                key: { ...key, pageId: SpacePageId.make("other-page") },
              },
              retained.sequence,
            ),
          ).rejects.toThrow();
          expect(await first.store.load()).toEqual([retained]);
        });
        yield* opened.database.clearAllCaches;
        yield* opened.close;
        const reopened = yield* fixture.open();
        const second = runtime(reopened, io, { newId: () => "f".repeat(32) });
        yield* Effect.promise(() => second.value.owner.hydrate());
        expect(second.value.owner.getSnapshot().records).toEqual([retained]);
        yield* Effect.promise(async () => {
          await second.value.owner.newAttempt(retained.id, {
            key,
            state: () => ({ pending: null }),
          });
          expect(await second.store.load()).toHaveLength(2);
          await expect(
            second.value.retain(key, selected, "third.png", () => true),
          ).rejects.toThrow();
          await second.value.owner.release(retained.id);
          expect(NodeFS.existsSync(io.uri(0, false))).toBe(true);
        });
        NodeFS.writeFileSync(io.uri(0, false), Buffer.alloc(png.length, 1));
        const third = runtime(reopened, io);
        yield* Effect.promise(async () => {
          await expect(third.value.owner.hydrate()).rejects.toThrow("changed");
          expect(await third.store.load()).toHaveLength(1);
          expect(NodeFS.existsSync(io.uri(0, false))).toBe(true);
        });
        NodeFS.writeFileSync(io.uri(0, false), png);
        yield* Effect.promise(async () => {
          await third.value.owner.hydrate();
          const started = Promise.withResolvers();
          const finish = Promise.withResolvers();
          const fileOwner = new MobileSpaceOriginalFiles(
            {
              ...io,
              upload: async (_uri, _url, _headers, signal) => {
                started.resolve();
                await finish.promise;
                if (signal.aborted) throw new Error("native cleanup completed");
              },
            },
            third.store.load,
            () => "e".repeat(32),
          );
          const record = third.value.owner.getSnapshot().records[0];
          const pending = fileOwner.post(
            record.original,
            "https://environment.example/upload",
            () => true,
          );
          await started.promise;
          pending.abort();
          await withNativeSpaceOriginals(third.store, fileOwner).remove(record);
          expect(await third.store.load()).toEqual([]);
          expect(NodeFS.existsSync(io.uri(0, false))).toBe(true);
          expect(await fileOwner.cleanup(0)).toBe(false);
          finish.resolve();
          await expect(pending.done).rejects.toThrow("native cleanup completed");
          expect(await fileOwner.cleanup(0)).toBe(true);
          expect(NodeFS.existsSync(io.uri(0, false))).toBe(false);
        });
        const db = new NodeSqlite.DatabaseSync(fixture.file);
        expect(db.prepare("PRAGMA user_version").get().user_version).toBe(4);
        db.close();
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
);

it.effect.each(["reply", "commit"])(
  "uploads actual retained disk bytes, recovers a lost finalize %s and page receipt across reopen, and retains newer content",
  (mode) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* diskDatabase();
        const configuration = yield* Layer.buildWithScope(
          Config.ServerConfig.layerTest(process.cwd(), { prefix: "mobile-original-upload-" }),
          yield* Effect.scope,
        );
        const config = Context.get(configuration, Config.ServerConfig);
        const serviceLayer = Service.layerFromPath(config.spacesDbPath, {
          assetsDir: config.spacesAssetsDir,
          stagingDir: config.spacesStagingDir,
        }).pipe(
          Layer.provide(
            Layer.mergeAll(
              NodeServices.layer,
              Settings.layerTest({ spacesEnabled: true }),
              Layer.succeed(Identity.ServerEnvironmentIdentity, {
                getEnvironmentId: Effect.succeed(env),
              }),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const service = yield* Service.SpacesService;
          const run = yield* promiseRunner();
          const library = yield* service.listSpaces({ environmentId: env });
          const page = yield* service.createPage({
            environmentId: env,
            receiptEpoch: library.mutationAdmission.epoch,
            mutationId: "image-page",
            spaceId: library.defaultSpaceId,
            baseRootOrderRevision: 0,
            title: "Image destination",
          });
          if (page.status !== "saved") throw new Error("Expected page");
          const pageKey = { environmentId: env, pageId: page.page.id };
          const cap = yield* service.getCapability(env);
          const open = yield* fixture.open();
          const source = NodePath.join(NodePath.dirname(fixture.file), "picked.png");
          NodeFS.writeFileSync(source, png);
          let posts = 0,
            finalizes = 0,
            applies = 0,
            receipts = 0,
            mints = 0,
            active = true,
            failFinalize = true,
            loseSave = true,
            loseMint = false,
            badRoute = mode === "commit";
          const caller = "native-caller";
          const io = fileIO(NodePath.dirname(fixture.file), async (uri, url, headers, signal) => {
            expect(signal.aborted).toBe(false);
            expect(headers).toEqual({
              "Content-Type": "image/png",
              "Content-Length": String(png.length),
            });
            expect(NodeFS.readFileSync(uri)).toEqual(png);
            posts++;
            await run(
              service.receiveAssetUpload(
                new URL(url).pathname.split("/").at(-1),
                headers["Content-Length"],
                Stream.fromAsyncIterable(NodeFS.createReadStream(uri), (error) => error),
              ),
            );
          });
          const remote = {
            access: () => {
              if (!active) throw new Error("Permission withdrawn");
              return { session: service, limits: cap.limits.assets };
            },
            mint: async (input) => {
              mints++;
              const result = await run(service.createAssetUpload(input, caller));
              if (badRoute) {
                badRoute = false;
                return { ...result, relativeUrl: "/api/spaces/assets/upload/../../not-upload" };
              }
              if (loseMint) {
                loseMint = false;
                throw new Error("lost initial mint");
              }
              return result;
            },
            status: (input) => run(service.getAssetUpload(input, caller)),
            finalize: async (input) => {
              finalizes++;
              const result = await run(service.finalizeAssetUpload(input, caller));
              if (failFinalize) {
                failFinalize = false;
                if (mode === "reply") throw new Error("lost finalize response");
                fixture.control.beforeCommit = async () => {
                  throw new Error("final record write rolled back");
                };
              }
              return result;
            },
            metadata: (input) => run(service.getAssetMetadata(input)),
          };
          const native = runtime(open, io, remote);
          yield* Effect.promise(() =>
            native.value.retain(pageKey, source, "original.png", () => active),
          );
          const id = native.value.owner.getSnapshot().records[0].id;
          if (mode === "commit")
            yield* Effect.promise(async () => {
              await expect(native.value.owner.upload(id)).rejects.toThrow();
              expect(posts).toBe(0);
              expect((await native.store.load())[0].phase).toBe("upload");
            });
          yield* Effect.promise(async () => {
            await expect(native.value.owner.upload(id)).rejects.toThrow();
            expect(posts).toBe(1);
            expect((await native.store.load())[0].phase).toBe("upload");
          });
          fixture.control.beforeCommit = null;
          yield* open.close;
          const reopened = yield* fixture.open();
          let restarted = runtime(reopened, io, { ...remote, newId: () => "d".repeat(32) });
          yield* Effect.promise(() => restarted.value.owner.hydrate());
          yield* Effect.promise(() => restarted.value.owner.recover(id));
          expect(restarted.value.owner.getSnapshot().records[0].phase).toBe("ready");
          expect(posts).toBe(1);
          expect(finalizes).toBe(1);
          const makeReader = (store) => {
            const session = new SpaceDocumentSession(pageKey, {
              drafts: store,
              createMutationId: () => `image-save-${++applies}`,
              maxLoadedBlocks: 100,
              maxMutations: 100,
              assertMutable: () => restarted.value.owner.assertMutable(pageKey),
              adapter: createSpaceServiceSessionAdapter(pageKey, {
                limits: () => cap.limits,
                getPage: (input) => run(service.getPage(input)),
                validateNewRequest: (request) => restarted.value.owner.validateNewRequest(request),
                applyBlockBatch: async (input) => {
                  const result = await run(service.applyBlockBatch(input));
                  if (loseSave) {
                    loseSave = false;
                    throw new Error("lost page reply");
                  }
                  return result;
                },
                lookupMutationReceipt: (input) => {
                  receipts++;
                  return run(service.lookupMutationReceipt(input));
                },
              }),
            });
            return new SpacesPageReader(
              { ...pageKey, spaceId: page.page.spaceId },
              {
                session,
                access: { availability: "writable", capability: cap, current: () => active },
                mediaBlocked: () => restarted.value.owner.isBlocked(pageKey),
                locate: async () => {
                  const located = await run(service.getPage(pageKey));
                  return { ...located, ancestors: [], current: () => (active ? located : null) };
                },
                blocks: (input) => run(service.readBlocks(input)),
              },
            );
          };
          let reader = makeReader(reopened.store);
          yield* Effect.promise(() => reader.first());
          expect(reader.completeImageWindow()).toBe(true);
          let insertion = mobileSpaceImageInsertion(
            reader,
            () => active,
            () => "native-image-block",
          );
          active = false;
          yield* Effect.promise(async () => {
            await expect(restarted.value.owner.insert(id, insertion)).rejects.toThrow("withdrawn");
          });
          active = true;
          if (mode === "commit") {
            fixture.control.beforeCommit = async () => {
              if (reader.session.getSnapshot().dirty) throw new Error("image draft rollback");
            };
            yield* Effect.promise(async () => {
              await expect(restarted.value.owner.insert(id, insertion)).rejects.toThrow();
              expect(restarted.value.owner.getSnapshot().records[0].phase).toBe("preparing");
              expect(reader.session.getSnapshot().blocks).toHaveLength(1);
              expect(() =>
                reader.session.apply([
                  { kind: "delete", blockId: reader.session.getSnapshot().blocks[0].id },
                ]),
              ).toThrow("retained image insertion");
            });
            fixture.control.beforeCommit = null;
            restarted = runtime(reopened, io, { ...remote, newId: () => "d".repeat(32) });
            yield* Effect.promise(() => restarted.value.owner.hydrate());
            reader = makeReader(reopened.store);
            yield* Effect.promise(() => reader.first());
            expect(reader.getSnapshot().error).toBeNull();
            expect(reader.getSnapshot().location?.page.id).toBe(pageKey.pageId);
            insertion = mobileSpaceImageInsertion(
              reader,
              () => active,
              () => "must-not-allocate-another-block",
            );
          }
          yield* Effect.promise(() => restarted.value.owner.insert(id, insertion));
          const retained = restarted.value.owner.getSnapshot().records[0];
          expect(retained.phase).toBe("drafted");
          yield* Effect.promise(async () => {
            await reader.editing.save();
            expect(reader.editing.getSnapshot().error).toContain("lost page reply");
            await expect(restarted.value.owner.release(id, insertion)).rejects.toThrow("pending");
          });
          const imageBlock = reader.session.getSnapshot().blocks[0];
          reader.session.apply([
            {
              kind: "replace",
              block: {
                ...imageBlock,
                content: { ...imageBlock.content, caption: [{ text: "later caption", marks: [] }] },
              },
            },
          ]);
          yield* Effect.promise(() => reader.session.persistDraft());
          reader = makeReader(reopened.store);
          yield* Effect.promise(() => reader.first());
          yield* Effect.promise(() => reader.editing.save());
          expect(receipts).toBe(1);
          expect(reader.session.getSnapshot().dirty).toBe(true);
          const current = mobileSpaceImageInsertion(
            reader,
            () => active,
            () => "unused",
          );
          yield* Effect.promise(async () => {
            await expect(restarted.value.owner.release(id, current)).rejects.toThrow("newer");
          });
          yield* Effect.promise(() => reader.editing.save());
          yield* Effect.promise(() => restarted.value.owner.release(id, current));
          expect(posts).toBe(1);
          expect(restarted.value.owner.getSnapshot().records).toEqual([]);
          expect(NodeFS.existsSync(io.uri(0, false))).toBe(false);
          loseMint = true;
          yield* Effect.promise(() =>
            restarted.value.retain(pageKey, source, "uncertain.png", () => true),
          );
          yield* Effect.promise(async () => {
            await expect(restarted.value.owner.upload("d".repeat(32))).rejects.toThrow(
              "lost initial mint",
            );
          });
          const unknown = runtime(reopened, io, remote);
          yield* Effect.promise(async () => {
            await unknown.value.owner.hydrate();
            await expect(unknown.value.owner.upload("d".repeat(32))).rejects.toThrow(
              "Mint outcome unresolved",
            );
            await expect(unknown.value.owner.release("d".repeat(32))).rejects.toThrow("unresolved");
            expect(mints).toBe(mode === "commit" ? 3 : 2);
            expect(posts).toBe(1);
            expect(NodeFS.existsSync(io.uri(0, false))).toBe(true);
          });
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              serviceLayer,
              Secrets.layer.pipe(Layer.provide(Layer.succeedContext(configuration))),
              WorkspacePaths.layer,
              Layer.succeedContext(configuration),
            ),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
);
