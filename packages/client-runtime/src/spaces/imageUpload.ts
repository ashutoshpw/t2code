import { EnvironmentId } from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import * as Schema from "effect/Schema";
import { spaceJsonBytes } from "./draft.ts";
import { isKnownSpaceBlock } from "./values.ts";
import type { SpaceDocumentDraft, SpaceSaveRequest, SpaceSessionSnapshot } from "./session.ts";
import { SpaceIntentAdmissionError } from "./session.ts";

const handleSchema = Schema.Struct({
  uploadId: C.SpaceAssetUploadId,
  assetId: C.SpaceAssetId,
  expiresAt: Schema.Number,
});
const placementSchema = Schema.Struct({
  block: C.SpaceBlock,
  revision: Schema.Number,
  generation: Schema.Number,
  windowIds: Schema.Array(C.SpaceBlockId),
});
const recordSchema = Schema.Struct({
  version: Schema.Literal(1),
  slot: Schema.Literals([0, 1]),
  sequence: Schema.Number,
  id: Schema.String,
  key: C.SpacePageTarget,
  original: Schema.Unknown,
  intent: C.SpaceAssetUploadCreateInput,
  phase: Schema.Literals(["original", "minting", "upload", "ready", "preparing", "drafted"]),
  handle: Schema.optionalKey(handleSchema),
  ready: Schema.optionalKey(C.SpaceAssetMetadata),
  placement: Schema.optionalKey(placementSchema),
  generation: Schema.optionalKey(Schema.Number),
});
export type SpaceImagePlacement = typeof placementSchema.Type;
export type SpaceImageRecord = Omit<typeof recordSchema.Type, "original"> & {
  readonly original: Blob;
};
const decodeRecord = Schema.decodeUnknownSync(recordSchema, { onExcessProperty: "error" });
class SpaceImageAdmissionError extends SpaceIntentAdmissionError {}
export const spaceImageMaxBytes = 10 * 1024 * 1024;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function imageAssetId(block: C.SpaceBlock) {
  return isKnownSpaceBlock(block) &&
    block.type === "image" &&
    typeof block.content.assetId === "string"
    ? C.SpaceAssetId.make(block.content.assetId)
    : null;
}
export function decodeSpaceImageRecord(input: unknown): SpaceImageRecord {
  const value = decodeRecord(input);
  if (
    !(value.original instanceof Blob) ||
    value.original.size < 1 ||
    value.original.size > spaceImageMaxBytes ||
    value.original.size !== value.intent.expectedBytes ||
    value.original.type !== value.intent.mimeType ||
    value.intent.mediaKind !== "image" ||
    !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(value.intent.mimeType) ||
    value.intent.environmentId !== value.key.environmentId ||
    value.intent.requestId !== value.id ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    !value.id ||
    value.id.length > 256
  )
    throw new Error("Invalid retained image original or intent; data is retained");
  const expected =
    value.phase === "original" || value.phase === "minting"
      ? [false, false, false, false]
      : value.phase === "upload"
        ? [true, false, false, false]
        : value.phase === "ready"
          ? [true, true, false, false]
          : value.phase === "preparing"
            ? [true, true, true, false]
            : [true, true, true, true];
  if (
    !same(
      [!!value.handle, !!value.ready, !!value.placement, value.generation !== undefined],
      expected,
    ) ||
    (value.handle && (!Number.isSafeInteger(value.handle.expiresAt) || value.handle.expiresAt < 0))
  )
    throw new Error("Inconsistent retained image phase; data is retained");
  if (value.phase !== "original" && value.phase !== "minting" && !value.handle)
    throw new Error("Retained image has no upload identity");
  if (
    ["ready", "preparing", "drafted"].includes(value.phase) &&
    (!value.ready ||
      value.ready.assetId !== value.handle?.assetId ||
      value.ready.byteSize !== value.original.size ||
      value.ready.mimeType !== value.intent.mimeType ||
      !value.ready.imageDimensions)
  )
    throw new Error("Invalid ready image identity");
  if (
    ["preparing", "drafted"].includes(value.phase) &&
    (!value.placement ||
      imageAssetId(value.placement.block) !== value.handle?.assetId ||
      value.placement.block.parentId !== null ||
      !/^[0-9a-f]{32}$/.test(value.placement.block.order) ||
      value.placement.windowIds.length > 99 ||
      value.placement.windowIds.includes(value.placement.block.id) ||
      new Set(value.placement.windowIds).size !== value.placement.windowIds.length ||
      !Number.isSafeInteger(value.placement.revision) ||
      value.placement.revision < 0 ||
      !Number.isSafeInteger(value.placement.generation) ||
      value.placement.generation < 0)
  )
    throw new Error("Invalid retained image placement");
  if (
    value.phase === "drafted" &&
    (!Number.isSafeInteger(value.generation) || value.generation! <= value.placement!.generation)
  )
    throw new Error("Invalid retained image generation");
  const { original, ...metadata } = value;
  spaceJsonBytes(metadata, 32768);
  const freeze = (value: unknown): void => {
    if (value && typeof value === "object") {
      for (const item of Object.values(value)) freeze(item);
      Object.freeze(value);
    }
  };
  freeze(metadata);
  return Object.freeze({ ...metadata, original });
}
export interface SpaceImageStore {
  readonly load: () => Promise<readonly SpaceImageRecord[]>;
  readonly put: (record: SpaceImageRecord, expected: number | null) => Promise<void>;
  readonly remove: (record: SpaceImageRecord) => Promise<void>;
}
export interface SpaceImageInsertion {
  readonly current: () => boolean;
  readonly key: C.SpacePageTarget;
  readonly state: () => SpaceSessionSnapshot;
  readonly complete: () => boolean;
  readonly plan: (assetId: C.SpaceAssetId) => SpaceImagePlacement;
  readonly apply: (placement: SpaceImagePlacement) => void;
  readonly persist: () => Promise<void>;
}
export interface SpaceImagePorts {
  readonly store: SpaceImageStore;
  readonly connect?: (environmentId: EnvironmentId) => Promise<void>;
  readonly access: (
    environmentId: EnvironmentId,
    write: boolean,
  ) => { session: object; limits: C.SpaceAssetLimits };
  readonly mint: (input: C.SpaceAssetUploadCreateInput) => Promise<C.SpaceAssetUploadCreateResult>;
  readonly status: (input: C.SpaceAssetUploadInput) => Promise<C.SpaceAssetUploadStatus>;
  readonly finalize: (input: C.SpaceAssetUploadInput) => Promise<C.SpaceAssetMetadata>;
  readonly metadata: (input: C.SpaceAssetGetInput) => Promise<C.SpaceAssetMetadata>;
  readonly post: (
    environmentId: EnvironmentId,
    relativeUrl: string,
    original: Blob,
    name: string,
  ) => { done: Promise<void>; abort: () => void };
  readonly draft: (key: C.SpacePageTarget) => Promise<SpaceDocumentDraft | null>;
  readonly saved: (
    key: C.SpacePageTarget,
    blockId: C.SpaceBlockId,
    assetId: C.SpaceAssetId,
  ) => Promise<boolean>;
  readonly newId: () => string;
  readonly changed: () => void;
}
interface ImageSnapshot {
  readonly records: readonly SpaceImageRecord[];
  readonly hydrated: boolean;
  readonly busy: boolean;
  readonly error: unknown;
}
export class SpaceImageUploads {
  readonly #ports: SpaceImagePorts;
  readonly #listeners = new Set<() => void>();
  readonly #mintOwners = new Map<string, object>();
  readonly #reserved = new Set<string>();
  #hydration: Promise<void> | null = null;
  #permit: string | null = null;
  #binding: { id: string; key: C.SpacePageTarget } | null = null;
  #abort: (() => void) | null = null;
  #snapshot: ImageSnapshot = { records: [], hydrated: false, busy: false, error: null };
  constructor(ports: SpaceImagePorts) {
    this.#ports = ports;
  }
  getSnapshot = () => this.#snapshot;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  #update(patch: Partial<ImageSnapshot>) {
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) listener();
    this.#ports.changed();
  }
  hydrate() {
    if (!this.#hydration)
      this.#hydration = this.#ports.store
        .load()
        .then((records) => {
          if (
            records.length > 2 ||
            new Set(records.map((r) => r.slot)).size !== records.length ||
            new Set(records.map((r) => r.id)).size !== records.length
          )
            throw new Error("Image storage exceeds two slots; all data retained");
          this.#update({
            records: records.map(decodeSpaceImageRecord),
            hydrated: true,
            error: null,
          });
        })
        .catch((error: unknown) => {
          this.#hydration = null;
          this.#update({ error });
          throw error;
        });
    return this.#hydration;
  }
  #key(key: C.SpacePageTarget) {
    return JSON.stringify([key.environmentId, key.pageId]);
  }
  isBlocked(key: C.SpacePageTarget) {
    return (
      (this.#binding !== null &&
        this.#key(this.#binding.key) === this.#key(key) &&
        this.#permit !== this.#binding.id) ||
      this.#snapshot.records.some(
        (r) =>
          this.#key(r.key) === this.#key(key) && r.phase === "preparing" && this.#permit !== r.id,
      )
    );
  }
  assertMutable(key: C.SpacePageTarget) {
    if (this.isBlocked(key))
      throw new SpaceImageAdmissionError(
        "Finish the retained image insertion before editing or saving",
      );
  }
  reserve(environmentId: EnvironmentId, pages: readonly C.SpacePageId[]) {
    if (this.#snapshot.busy)
      throw new Error("Finish the active image operation before page placement");
    const keys = pages.map((pageId) => this.#key({ environmentId, pageId }));
    if (keys.some((k) => this.#reserved.has(k)))
      throw new Error("Image destination already reserved");
    for (const k of keys) this.#reserved.add(k);
    return () => {
      for (const k of keys) this.#reserved.delete(k);
    };
  }
  async checkPages(environmentId: EnvironmentId, pages: readonly C.SpacePageId[]) {
    await this.hydrate();
    if (
      this.#snapshot.records.some(
        (r) => r.key.environmentId === environmentId && pages.includes(r.key.pageId),
      )
    )
      throw new Error("Resolve retained image originals for the affected pages first");
  }
  #record(id: string) {
    const r = this.#snapshot.records.find((r) => r.id === id);
    if (!r) throw new Error("Image original is unavailable");
    return r;
  }
  async #write(record: SpaceImageRecord, previous: SpaceImageRecord | null) {
    const value = decodeSpaceImageRecord(record);
    await this.#ports.store.put(value, previous?.sequence ?? null);
    this.#update({ records: [...this.#snapshot.records.filter((r) => r.id !== value.id), value] });
    return value;
  }
  #next(r: SpaceImageRecord, patch: Partial<SpaceImageRecord>) {
    return this.#write({ ...r, ...patch, sequence: r.sequence + 1 }, r);
  }
  #run<A>(use: () => Promise<A>): Promise<A> {
    if (this.#snapshot.busy)
      return Promise.reject(new Error("One image operation is already active"));
    this.#update({ busy: true, error: null });
    return use()
      .catch((error: unknown) => {
        this.#update({ error });
        throw error;
      })
      .finally(() => {
        this.#abort = null;
        this.#binding = null;
        this.#update({ busy: false });
      });
  }
  abort() {
    this.#abort?.();
  }
  add(key: C.SpacePageTarget, original: Blob, name: string) {
    return this.#run(async () => {
      await this.hydrate();
      await this.#ports.connect?.(key.environmentId);
      const { limits } = this.#ports.access(key.environmentId, true);
      if (this.#reserved.has(this.#key(key))) throw new Error("Page placement is reserved");
      if (original.size > Math.min(spaceImageMaxBytes, limits.maxImageBytes))
        throw new Error("Image exceeds current byte policy");
      const slot = [0, 1].find((s) => !this.#snapshot.records.some((r) => r.slot === s));
      if (slot === undefined)
        throw new Error("Two image originals are retained; resolve one before adding another");
      const id = this.#ports.newId();
      return this.#write(
        decodeSpaceImageRecord({
          version: 1,
          slot,
          sequence: 1,
          id,
          key,
          original,
          phase: "original",
          intent: {
            environmentId: key.environmentId,
            requestId: id,
            expectedBytes: original.size,
            mimeType: original.type,
            mediaKind: "image",
            name,
          },
        }),
        null,
      );
    });
  }
  #sameSession(r: Pick<SpaceImageRecord, "key">, session: object, write: boolean) {
    const access = this.#ports.access(r.key.environmentId, write);
    if (access.session !== session)
      throw new Error("Image connection changed; recover the original upload explicitly");
    return access;
  }
  #ready(r: SpaceImageRecord, value: C.SpaceAssetMetadata) {
    const limits = this.#ports.access(r.key.environmentId, false).limits;
    if (
      value.assetId !== r.handle?.assetId ||
      value.byteSize !== r.original.size ||
      value.mimeType !== r.intent.mimeType ||
      !value.imageDimensions ||
      value.imageDimensions.width * value.imageDimensions.height >
        Math.min(24000000, limits.maxImagePixels)
    )
      throw new Error("Ready image does not match its retained original or pixel policy");
    return value;
  }
  upload(id: string) {
    return this.#run(async () => {
      await this.hydrate();
      let r = this.#record(id);
      await this.#ports.connect?.(r.key.environmentId);
      const { session } = this.#ports.access(r.key.environmentId, true);
      if (this.#reserved.has(this.#key(r.key)) || ["preparing", "drafted"].includes(r.phase))
        throw new Error("Image already has a document binding or placement reservation");
      let grant: C.SpaceAssetUploadCreateResult | null = null;
      if (!r.handle) {
        if (r.phase === "original") {
          r = await this.#next(r, { phase: "minting" });
          this.#mintOwners.set(id, session);
        } else if (this.#mintOwners.get(id) !== session)
          throw new Error(
            "Mint outcome unresolved for this caller. Original retained; no new mint was sent",
          );
        this.#sameSession(r, session, true);
        grant = await this.#ports.mint(r.intent);
        r = await this.#next(r, {
          phase: "upload",
          handle: { uploadId: grant.uploadId, assetId: grant.assetId, expiresAt: grant.expiresAt },
        });
      }
      this.#sameSession(r, session, true);
      if (r.phase === "ready") {
        await this.#ports
          .metadata({ environmentId: r.key.environmentId, assetId: r.handle!.assetId })
          .then((v) => this.#ready(r, v));
        return;
      }
      const input = { environmentId: r.key.environmentId, uploadId: r.handle!.uploadId };
      let status: C.SpaceAssetUploadStatus;
      try {
        status = await this.#ports.status(input);
      } catch (error) {
        const ready = await this.#ports
          .metadata({ environmentId: r.key.environmentId, assetId: r.handle!.assetId })
          .catch(() => null);
        if (!ready) throw error;
        await this.#next(r, { phase: "ready", ready: this.#ready(r, ready) });
        return;
      }
      this.#sameSession(r, session, true);
      if (
        status.uploadId !== r.handle!.uploadId ||
        status.assetId !== r.handle!.assetId ||
        status.expiresAt !== r.handle!.expiresAt
      )
        throw new Error("Upload status identity mismatch");
      if (status.state === "receiving")
        throw new Error(
          "Original upload is receiving; retry status explicitly, without resending bytes",
        );
      if (status.state === "expired")
        throw new Error(
          "Original upload expired; retained original requires an explicit new attempt",
        );
      if (status.state === "reserved") {
        if (!grant) grant = await this.#ports.mint(r.intent);
        if (
          grant.uploadId !== r.handle!.uploadId ||
          grant.assetId !== r.handle!.assetId ||
          grant.expiresAt !== r.handle!.expiresAt
        )
          throw new Error("Caller-bound mint replay returned a different handle");
        this.#sameSession(r, session, true);
        const transport = this.#ports.post(
          r.key.environmentId,
          grant.relativeUrl,
          r.original,
          r.intent.name,
        );
        this.#abort = transport.abort;
        await transport.done;
      }
      this.#sameSession(r, session, true);
      const ready = await this.#ports.finalize(input);
      r = await this.#next(r, { phase: "ready", ready: this.#ready(r, ready) });
      return r;
    });
  }
  async readMetadata(environmentId: EnvironmentId, assetId: C.SpaceAssetId) {
    await this.#ports.connect?.(environmentId);
    const { session } = this.#ports.access(environmentId, false);
    const metadata = await this.#ports.metadata({ environmentId, assetId });
    spaceJsonBytes(metadata, 16384);
    if (metadata.assetId !== assetId) throw new Error("Media metadata identity mismatch");
    const current = () => {
      try {
        return this.#ports.access(environmentId, false).session === session;
      } catch {
        return false;
      }
    };
    if (!current()) throw new Error("Image source connection changed");
    return { metadata, current };
  }
  recover(id: string) {
    return this.#run(async () => {
      await this.hydrate();
      const r = this.#record(id);
      if (!r.handle)
        throw new Error(
          "Mint outcome has no known handle; retain the original and caller identity",
        );
      await this.#ports.connect?.(r.key.environmentId);
      this.#ports.access(r.key.environmentId, false);
      const status = await this.#ports
        .status({ environmentId: r.key.environmentId, uploadId: r.handle.uploadId })
        .catch(() => null);
      if (status && (status.assetId !== r.handle.assetId || status.uploadId !== r.handle.uploadId))
        throw new Error("Original upload identity mismatch");
      if (status && status.state !== "ready")
        throw new Error(
          `Original upload is ${status.state}. Continue the same upload explicitly when permitted.`,
        );
      const ready = await this.readMetadata(r.key.environmentId, r.handle.assetId);
      if (r.phase === "upload")
        await this.#next(r, { phase: "ready", ready: this.#ready(r, ready.metadata) });
      return ready.metadata;
    });
  }
  async validateNewRequest(request: SpaceSaveRequest) {
    try {
      const assets = new Set(
        request.mutations.flatMap((m) =>
          m.kind === "delete" ? [] : imageAssetId(m.block) ? [imageAssetId(m.block)!] : [],
        ),
      );
      if (!assets.size) return;
      await this.#ports.connect?.(request.key.environmentId);
      const { session } = this.#ports.access(request.key.environmentId, true);
      for (const assetId of assets) {
        const value = await this.#ports.metadata({
          environmentId: request.key.environmentId,
          assetId,
        });
        if (
          value.assetId !== assetId ||
          !value.mimeType.startsWith("image/") ||
          !value.imageDimensions
        )
          throw new Error(
            "Image is no longer ready; original/draft retained for explicit recovery",
          );
        this.#sameSession({ key: request.key }, session, true);
      }
    } catch (error) {
      throw new SpaceImageAdmissionError(
        "Image is unavailable for a new save; original and draft retained for explicit recovery",
        { cause: error },
      );
    }
  }
  insert(id: string, target: SpaceImageInsertion) {
    return this.#run(async () => {
      await this.hydrate();
      let r = this.#record(id);
      if (this.#key(r.key) !== this.#key(target.key) || this.#reserved.has(this.#key(r.key)))
        throw new Error("Image destination changed");
      await this.#ports.connect?.(r.key.environmentId);
      const { session } = this.#ports.access(r.key.environmentId, true);
      if (r.phase === "ready") {
        this.#ready(
          r,
          await this.#ports.metadata({
            environmentId: r.key.environmentId,
            assetId: r.handle!.assetId,
          }),
        );
        this.#sameSession(r, session, true);
        const placement = target.plan(r.handle!.assetId);
        this.#binding = { id, key: r.key };
        this.#ports.changed();
        await target.persist();
        r = await this.#next(r, { phase: "preparing", placement });
      } else if (r.phase !== "preparing")
        throw new Error("Image already bound or not ready; no duplicate insertion");
      if (!target.current())
        throw new Error(
          "Image destination view is no longer current; retained placement was not applied",
        );
      const p = r.placement!,
        state = target.state();
      const existing = state.blocks.find((b) => b.id === p.block.id);
      if (existing && !same(existing, p.block))
        throw new Error("Image block identity changed; retained binding unresolved");
      if (!existing) {
        if (
          !target.complete() ||
          state.baseRevision !== p.revision ||
          state.generation !== p.generation ||
          state.pending ||
          !same(
            state.blocks.map((b) => b.id),
            p.windowIds,
          )
        )
          throw new Error(
            "Original insertion position is no longer proven; retained intent requires explicit recovery",
          );
        this.#sameSession(r, session, true);
        this.#permit = id;
        try {
          target.apply(p);
        } finally {
          this.#permit = null;
          this.#ports.changed();
        }
      }
      await target.persist();
      const draft = await this.#ports.draft(r.key);
      if (!draft || !draft.blocks.some((b) => same(b, p.block)) || draft.generation <= p.generation)
        throw new Error("Image draft binding is not durable; original retained");
      await this.#next(r, { phase: "drafted", generation: draft.generation });
    });
  }
  reselectPlacement(id: string, target: SpaceImageInsertion) {
    return this.#run(async () => {
      await this.hydrate();
      const r = this.#record(id),
        p = r.placement;
      if (
        r.phase !== "preparing" ||
        !p ||
        !target.current() ||
        this.#key(target.key) !== this.#key(r.key)
      )
        throw new Error("No current unsent image placement to reselect");
      await target.persist();
      const state = target.state(),
        draft = await this.#ports.draft(r.key);
      if (
        !target.complete() ||
        state.pending ||
        state.baseRevision !== p.revision ||
        state.memberIds.includes(p.block.id) ||
        state.blocks.some((b) => b.id === p.block.id) ||
        draft?.pending ||
        draft?.blocks.some((b) => b.id === p.block.id)
      )
        throw new Error(
          "The original placement may have been applied; finish its exact binding instead",
        );
      const { placement: _placement, generation: _generation, ...rest } = r;
      await this.#write({ ...rest, sequence: r.sequence + 1, phase: "ready" }, r);
    });
  }
  async newAttempt(id: string, target: SpaceImageInsertion) {
    await this.hydrate();
    const record = this.#record(id);
    if (
      this.#key(record.key) !== this.#key(target.key) ||
      ["minting", "preparing"].includes(record.phase) ||
      target.state().pending
    )
      throw new Error("Resolve the original outcome before starting a new image intent");
    return this.add(record.key, record.original, record.intent.name);
  }
  release(id: string, target?: SpaceImageInsertion) {
    return this.#run(async () => {
      await this.hydrate();
      const r = this.#record(id);
      if (["minting", "preparing"].includes(r.phase))
        throw new Error("Image outcome unresolved; retain its original");
      if (r.phase === "drafted") {
        if (!target || this.#key(target.key) !== this.#key(r.key))
          throw new Error(
            "Open the image's page to verify its draft before releasing the original",
          );
        this.#binding = { id, key: r.key };
        this.#ports.changed();
        await target.persist();
        const s = target.state(),
          p = r.placement!;
        if (s.pending || s.persistenceError)
          throw new Error("Resolve the exact pending document receipt first");
        const unsentRemoved =
          s.baseRevision === p.revision &&
          !s.memberIds.includes(p.block.id) &&
          !s.blocks.some((b) => imageAssetId(b) === r.handle!.assetId);
        const acknowledged =
          !s.dirty &&
          s.memberIds.includes(p.block.id) &&
          ((s.acknowledgedGeneration ?? -1) >= r.generation! ||
            (await this.#ports.saved(r.key, p.block.id, r.handle!.assetId)));
        if (!unsentRemoved && !acknowledged)
          throw new Error(
            "Save or resolve newer image drafts before releasing the retained original",
          );
      }
      await this.#ports.store.remove(r);
      this.#update({ records: this.#snapshot.records.filter((value) => value.id !== id) });
    });
  }
}
