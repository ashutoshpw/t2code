import * as Schema from "effect/Schema";
import { EnvironmentId } from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import type { SpaceDraftStore } from "./session.ts";
import { isSpaceListItem } from "./values.ts";
import { spaceDraftMaxBytes, spaceJsonBytes } from "./draft.ts";

const context = {
  targetSpaceId: Schema.optionalKey(C.SpaceId),
  sourceLocation: Schema.optionalKey(C.SpacePageLocation),
};
const placement = Schema.Struct({
  operation: Schema.optionalKey(Schema.Literals(["movePage", "moveBlocks"])),
  blockIds: Schema.optionalKey(Schema.Array(C.SpaceBlockId)),
  ...context,
  pageId: C.SpacePageId,
  destination: C.SpacePageDestination,
  opposite: C.SpacePageDestination,
  guards: C.SpaceStructureGuards,
  observed: C.SpaceStructureGuards,
});
const recoveryHistory = Schema.Struct({
  operation: Schema.Literals(["trashPage", "restorePage"]),
  scope: Schema.Literals(["created child", "page recovery"]),
  pageId: C.SpacePageId,
  pageIds: Schema.Array(C.SpacePageId),
  pages: Schema.Array(C.SpacePageSummary),
  guards: C.SpaceStructureGuards,
  observed: C.SpaceStructureGuards,
  direction: Schema.Literals(["undo", "redo"]),
});
const pendingSchema = Schema.Struct({
  ...context,
  request: Schema.Union([
    Schema.Struct({ operation: Schema.Literal("movePage"), input: C.SpaceMovePageInput }),
    Schema.Struct({ operation: Schema.Literal("moveBlocks"), input: C.SpaceMoveBlocksInput }),
    Schema.Struct({
      operation: Schema.Literal("createChildPage"),
      input: C.SpaceCreateChildPageInput,
    }),
    Schema.Struct({ operation: Schema.Literal("trashPage"), input: C.SpacePageRecoveryInput }),
    Schema.Struct({ operation: Schema.Literal("restorePage"), input: C.SpacePageRecoveryInput }),
    Schema.Struct({
      operation: Schema.Literal("permanentlyDeletePage"),
      input: C.SpacePageRecoveryInput,
    }),
  ]),
  recoveryPageIds: Schema.optionalKey(Schema.Array(C.SpacePageId)),
  recoveryBefore: Schema.optionalKey(Schema.Array(C.SpacePageSummary)),
  recoveryScope: Schema.optionalKey(Schema.Literals(["created child", "page recovery"])),
  knownBlockIds: Schema.optionalKey(Schema.Array(C.SpaceBlockId)),
  inverse: Schema.NullOr(C.SpacePageDestination),
  observed: C.SpaceStructureGuards,
  direction: Schema.Literals(["move", "undo", "redo"]),
  conflict: Schema.Boolean,
  rejection: Schema.optionalKey(Schema.Literals(["invalid_input", "invalid_recovery_state"])),
});
const journalSchema = Schema.Struct({
  version: Schema.Literal(1),
  environmentId: EnvironmentId,
  pending: Schema.NullOr(pendingSchema),
  history: Schema.NullOr(
    Schema.Union([
      Schema.Struct({ ...placement.fields, direction: Schema.Literals(["undo", "redo"]) }),
      recoveryHistory,
    ]),
  ),
});
export type SpaceStructureJournal = typeof journalSchema.Type;
type Pending = typeof pendingSchema.Type;
type Destination = C.SpacePageDestination;
type MoveReceipt =
  | { operation: "movePage"; result: C.SpaceMovePageResult }
  | { operation: "moveBlocks"; result: C.SpaceMoveBlocksResult }
  | { operation: "createChildPage"; result: C.SpaceCreateChildPageResult }
  | { operation: "trashPage" | "restorePage"; result: C.SpacePageRecoveryResult }
  | { operation: "permanentlyDeletePage"; result: C.SpacePagePurgeResult };
const sameLocation = (a: C.SpacePageLocation, b: C.SpacePageLocation) =>
  a.kind === b.kind &&
  a.spaceId === b.spaceId &&
  (a.kind === "root" ||
    (b.kind === "child" && a.ownerBlockId === b.ownerBlockId && a.parentPageId === b.parentPageId));
const recoveryRequest = (operation: Pending["request"]["operation"]) =>
  operation === "trashPage" || operation === "restorePage" || operation === "permanentlyDeletePage";
const sameIds = <A extends string>(a: readonly A[], b: readonly A[]) =>
  a.length === b.length && new Set(a).size === a.length && a.every((id) => b.includes(id));
function sameRecoveryContext(a: readonly C.SpacePageSummary[], b: readonly C.SpacePageSummary[]) {
  return (
    sameIds(
      a.map((p) => p.id),
      b.map((p) => p.id),
    ) &&
    a.every((p) => {
      const other = b.find((row) => row.id === p.id)!;
      return (
        (p.location
          ? !!other.location && sameLocation(p.location, other.location)
          : !other.location) &&
        (p.trash
          ? !!other.trash &&
            p.trash.batchId === other.trash.batchId &&
            p.trash.originalRootPageId === other.trash.originalRootPageId &&
            p.trash.trashedAt === other.trash.trashedAt
          : !other.trash)
      );
    })
  );
}
function recoveryPages(pages: readonly C.SpacePageSummary[], expected: C.SpaceStructureGuards) {
  if (
    !sameIds(
      pages.map((p) => p.id),
      expected.pages.map((p) => p.pageId),
    ) ||
    !pages.every((p) => expected.pages.some((g) => g.pageId === p.id && g.revision === p.revision))
  )
    throw new Error("Invalid retained recovery page context");
}
export const spaceStructureMaxBytes = 2 * 1024 * 1024;
const decode = Schema.decodeUnknownSync(journalSchema, { onExcessProperty: "error" });
const isValidationError = Schema.is(C.SpaceValidationError);
const copy = <A>(value: A): A => JSON.parse(JSON.stringify(value)) as A;
function freeze<A>(value: A): A {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function guards(value: C.SpaceStructureGuards) {
  if (
    value.pages.length < 1 ||
    value.pages.length > 8 ||
    value.roots.length > 2 ||
    new Set(value.roots.map((p) => p.spaceId)).size !== value.roots.length ||
    new Set(value.pages.map((p) => p.pageId)).size !== value.pages.length ||
    value.pages.some((p) => !Number.isSafeInteger(p.revision)) ||
    value.roots.some((p) => !Number.isSafeInteger(p.rootOrderRevision))
  )
    throw new Error("Page placement exceeds the eight-page guard boundary");
}
function merge(a: C.SpaceStructureGuards, b: C.SpaceStructureGuards): C.SpaceStructureGuards {
  return {
    pages: [...new Map([...a.pages, ...b.pages].map((p) => [p.pageId, p])).values()],
    roots: [...new Map([...a.roots, ...b.roots].map((p) => [p.spaceId, p])).values()],
  };
}
function covered(known: C.SpaceStructureGuards, proposed: C.SpaceStructureGuards) {
  return (
    proposed.pages.every((p) =>
      known.pages.some((k) => k.pageId === p.pageId && k.revision === p.revision),
    ) &&
    proposed.roots.every((p) =>
      known.roots.some(
        (k) => k.spaceId === p.spaceId && k.rootOrderRevision === p.rootOrderRevision,
      ),
    )
  );
}
export function decodeSpaceStructureJournal(
  value: unknown,
  environmentId: EnvironmentId,
): SpaceStructureJournal {
  spaceJsonBytes(value, spaceStructureMaxBytes);
  const journal = decode(value);
  if (journal.environmentId !== environmentId)
    throw new Error("Structural journal belongs to another environment");
  const destination = (d: Destination, pageId: C.SpacePageId, g: C.SpaceStructureGuards) => {
    if (d.kind === "root") {
      if (d.beforePageId === pageId || !g.roots.some((r) => r.spaceId === d.spaceId))
        throw new Error("Invalid retained root placement");
    } else if (
      d.placement.pageId === pageId ||
      !g.pages.some((p) => p.pageId === d.placement.pageId)
    )
      throw new Error("Invalid retained child placement");
  };
  const source = (location: C.SpacePageLocation | undefined, d: Destination) => {
    if (!location) return;
    if (
      location.kind === "root"
        ? d.kind !== "root" || d.spaceId !== location.spaceId
        : d.kind !== "child" || d.placement.pageId !== location.parentPageId
    )
      throw new Error("Retained ownership does not match its placement");
  };
  const roots = (ids: readonly C.SpaceBlockId[]) => {
    if (ids.length < 1 || ids.length > 100 || new Set(ids).size !== ids.length)
      throw new Error("Invalid selected move roots");
  };
  const p = journal.pending;
  if (p) {
    const request = p.request,
      input = request.input;
    if (
      input.environmentId !== environmentId ||
      input.mutationId.length > 128 ||
      !covered(p.observed, input.guards)
    )
      throw new Error("Invalid retained placement");
    guards(input.guards);
    guards(p.observed);
    if (p.rejection && (request.operation !== "permanentlyDeletePage" || !p.conflict))
      throw new Error("Invalid retained permanent-deletion rejection");
    if (
      (request.operation !== "createChildPage" && p.knownBlockIds !== undefined) ||
      (!recoveryRequest(request.operation) &&
        (p.recoveryPageIds !== undefined ||
          p.recoveryBefore !== undefined ||
          p.recoveryScope !== undefined))
    )
      throw new Error("Retained operation metadata does not match its request");
    if (request.operation === "moveBlocks") {
      const i = request.input;
      roots(i.blockIds);
      if (
        (p.inverse !== null &&
          (p.inverse.kind !== "child" || p.inverse.placement.pageId !== i.sourcePageId)) ||
        !i.guards.pages.some((g) => g.pageId === i.sourcePageId) ||
        !i.guards.pages.some((g) => g.pageId === i.destination.pageId)
      )
        throw new Error("Invalid retained block ownership or inverse");
    } else if (request.operation === "createChildPage") {
      if (
        p.inverse ||
        p.direction !== "move" ||
        !p.targetSpaceId ||
        !p.knownBlockIds ||
        p.observed.pages.length >= 8 ||
        !sameIds(
          input.guards.pages.map((g) => g.pageId),
          p.observed.pages.map((g) => g.pageId),
        ) ||
        !p.observed.roots.every(
          (g) =>
            input.guards.roots.some((k) => k.spaceId === g.spaceId) ||
            g.spaceId === p.targetSpaceId,
        ) ||
        !input.guards.pages.some((g) => g.pageId === request.input.placement.pageId) ||
        p.knownBlockIds.length > 100 ||
        new Set(p.knownBlockIds).size !== p.knownBlockIds.length
      )
        throw new Error("Invalid retained child creation");
    } else if (
      request.operation === "trashPage" ||
      request.operation === "restorePage" ||
      request.operation === "permanentlyDeletePage"
    ) {
      if (
        p.inverse ||
        (request.operation === "permanentlyDeletePage" && p.direction !== "move") ||
        !p.recoveryPageIds ||
        p.recoveryPageIds.length < 1 ||
        p.recoveryPageIds.length > 8 ||
        !p.recoveryPageIds.includes(request.input.pageId) ||
        new Set(p.recoveryPageIds).size !== p.recoveryPageIds.length ||
        !p.recoveryPageIds.every((id) => input.guards.pages.some((g) => g.pageId === id))
      )
        throw new Error("Invalid retained recovery closure");
      if (p.recoveryBefore) recoveryPages(p.recoveryBefore, input.guards);
      if (p.direction !== "move" && (!p.recoveryBefore || !p.recoveryScope))
        throw new Error("Missing retained compensation context");
    } else {
      const i = request.input;
      if (
        !p.observed.pages.some((row) => row.pageId === i.pageId) ||
        (i.destination.kind === "child" && (!p.targetSpaceId || !p.sourceLocation))
      )
        throw new Error("Invalid retained page placement");
      if (!p.inverse) throw new Error("A page move must retain its original placement");
      destination(i.destination, i.pageId, i.guards);
      destination(p.inverse, i.pageId, p.observed);
      source(p.sourceLocation, p.inverse);
      if (
        p.targetSpaceId &&
        i.destination.kind === "root" &&
        p.targetSpaceId !== i.destination.spaceId
      )
        throw new Error("Invalid retained destination space");
    }
    spaceJsonBytes(request, 1024 * 1024);
  }
  const h = journal.history;
  if (h) {
    guards(h.guards);
    guards(h.observed);
    if (!h.guards.pages.some((p) => p.pageId === h.pageId) || !covered(h.observed, h.guards))
      throw new Error("Invalid retained placement history");
    if (h.operation === "trashPage" || h.operation === "restorePage") {
      recoveryPages(h.pages, h.guards);
      if (
        h.pageIds.length < 1 ||
        h.pageIds.length > 8 ||
        !h.pageIds.includes(h.pageId) ||
        new Set(h.pageIds).size !== h.pageIds.length ||
        !h.pageIds.every((id) => h.guards.pages.some((g) => g.pageId === id)) ||
        (h.scope === "created child" && h.pageIds.length !== 1)
      )
        throw new Error("Invalid retained recovery history selection");
      const selected = h.pages.filter((p) => h.pageIds.includes(p.id));
      if (
        h.operation === "trashPage"
          ? selected.some((p) => p.trash)
          : selected.some((p) => !p.trash || p.trash.batchId !== selected[0]?.trash?.batchId)
      )
        throw new Error("Invalid retained recovery history batch");
    } else if (h.operation === "moveBlocks") {
      if (
        !h.blockIds ||
        h.destination.kind !== "child" ||
        h.opposite.kind !== "child" ||
        h.opposite.placement.pageId !== h.pageId ||
        !h.guards.pages.some(
          (g) =>
            g.pageId === (h.destination.kind === "child" ? h.destination.placement.pageId : null),
        )
      )
        throw new Error("Invalid retained block history");
      roots(h.blockIds);
    } else if ("destination" in h) {
      if (h.destination.kind === "child" && (!h.targetSpaceId || !h.sourceLocation))
        throw new Error("Invalid retained placement history");
      destination(h.destination, h.pageId, h.guards);
      destination(h.opposite, h.pageId, h.observed);
      source(h.sourceLocation, h.opposite);
      if (
        h.targetSpaceId &&
        h.destination.kind === "root" &&
        h.targetSpaceId !== h.destination.spaceId
      )
        throw new Error("Invalid retained inverse space");
    }
    spaceJsonBytes(h, 256 * 1024);
  }
  if (
    p &&
    p.direction !== "move" &&
    (p.request.operation === "trashPage" || p.request.operation === "restorePage")
  ) {
    if (
      !h ||
      h.operation !== p.request.operation ||
      h.pageId !== p.request.input.pageId ||
      h.direction !== p.direction ||
      h.scope !== p.recoveryScope ||
      !sameIds(h.pageIds, p.recoveryPageIds ?? []) ||
      !sameRecoveryContext(h.pages, p.recoveryBefore ?? []) ||
      !covered(h.guards, p.request.input.guards) ||
      !covered(p.request.input.guards, h.guards)
    )
      throw new Error("Recovery compensation does not match retained history");
  }
  return journal;
}
export interface SpaceStructureStore {
  load(environmentId: EnvironmentId): Promise<SpaceStructureJournal | null>;
  write(environmentId: EnvironmentId, journal: SpaceStructureJournal): Promise<void>;
}
export async function checkSpaceStructureDrafts(
  store: SpaceDraftStore,
  environmentId: EnvironmentId,
  pages: readonly C.SpacePageId[],
) {
  if (pages.length > 8 || new Set(pages).size !== pages.length)
    throw new Error("Placement exceeds eight affected drafts");
  let bytes = 0;
  for (const pageId of pages) {
    const draft = await store.load({ environmentId, pageId });
    if (!draft) continue;
    bytes += spaceJsonBytes(draft, spaceDraftMaxBytes);
    if (bytes > 4 * 1024 * 1024)
      throw new Error("Affected drafts exceed the placement read budget");
    if (draft.pending || draft.mutations.length || draft.history?.action)
      throw new Error(
        "An affected page has a retained draft. Open and resolve it before moving the page",
      );
  }
}
export interface SpaceRootReorderPorts {
  readonly store: SpaceStructureStore;
  readonly spaces: (input: C.SpaceListInput) => Promise<C.SpaceListResult>;
  readonly blocks: (input: C.SpaceReadBlocksInput) => Promise<C.SpaceReadBlocksResult>;
  readonly list: (input: C.SpacePageListInput) => Promise<C.SpacePageListResult>;
  readonly inspect: (input: C.SpaceInspectStructureInput) => Promise<C.SpaceInspectStructureResult>;
  readonly getPage: (pageId: C.SpacePageId) => Promise<C.SpacePageGetResult>;
  readonly capability: () => Pick<C.SpaceCapability, "version" | "features" | "limits"> | undefined;
  readonly createChild: (
    input: C.SpaceCreateChildPageInput,
  ) => Promise<C.SpaceCreateChildPageResult>;
  readonly recovery: (
    operation: "trashPage" | "restorePage",
    input: C.SpacePageRecoveryInput,
  ) => Promise<C.SpacePageRecoveryResult>;
  readonly purge: (input: C.SpacePageRecoveryInput) => Promise<C.SpacePagePurgeResult>;
  readonly trashList: (input: C.SpaceTrashListInput) => Promise<C.SpaceTrashListResult>;
  readonly moveBlocks: (input: C.SpaceMoveBlocksInput) => Promise<C.SpaceMoveBlocksResult>;
  readonly move: (input: C.SpaceMovePageInput) => Promise<C.SpaceMovePageResult>;
  readonly receipt: (input: C.SpaceReceiptLookupInput) => Promise<C.SpaceReceiptLookupResult>;
  readonly newId: () => string;
  readonly assertAccess: (write: boolean) => void;
  readonly maxMutationBytes: () => number;
  readonly maxRows: () => number;
  readonly reserve: (pages: readonly C.SpacePageId[], restoring: boolean) => () => void;
  readonly checkDrafts: (pages: readonly C.SpacePageId[]) => Promise<void>;
  readonly refresh: (pages: readonly C.SpacePageId[]) => Promise<void>;
  readonly changed: () => void;
}
interface Position {
  readonly pageId: C.SpacePageId;
  readonly revision: number;
  readonly rootRevision: number;
  readonly beforePageId: C.SpacePageId | null;
  readonly location: C.SpacePageLocation;
  readonly destination: Destination;
  readonly guards: C.SpaceStructureGuards;
}
export interface SpaceBlockMoveProof {
  readonly sourcePageId: C.SpacePageId;
  readonly revision: number;
  readonly blockIds: readonly C.SpaceBlockId[];
  readonly selectedIds: readonly C.SpaceBlockId[];
  readonly inverse: C.SpaceBlockPlacement | null;
  readonly indent: C.SpaceBlockPlacement | null;
  readonly outdent: C.SpaceBlockPlacement | null;
}
export interface SpaceRecoveryPreview {
  readonly pageId: C.SpacePageId;
  readonly operation: C.SpaceRecoveryOperation;
  readonly inspection: C.SpaceInspectStructureResult;
  readonly placement: string;
}
interface Snapshot {
  readonly trash: C.SpaceTrashListResult | null;
  readonly recoveryPreview: SpaceRecoveryPreview | null;
  readonly blockSelection: SpaceBlockMoveProof | null;
  readonly hydrated: boolean;
  readonly busy: boolean;
  readonly journal: SpaceStructureJournal;
  readonly window: C.SpacePageListResult | null;
  readonly position: Position | null;
  readonly spaces: C.SpaceListResult | null;
  readonly parentPageId: C.SpacePageId | null;
  readonly body: {
    pageId: C.SpacePageId;
    spaceId: C.SpaceId;
    revision: number;
    blocks: readonly C.SpaceBlock[];
    nextCursor: C.SpaceCursor | null;
  } | null;
  readonly error: unknown;
  readonly notice: string | null;
}

export class SpaceRootReorder {
  readonly #ports: SpaceRootReorderPorts;
  readonly environmentId: EnvironmentId;
  #snapshot: Snapshot;
  readonly #listeners = new Set<() => void>();
  #ready: Promise<void> | null = null;
  #work: Promise<void> | null = null;
  #release: (() => void) | null = null;
  #unsent = false;
  #accepted: MoveReceipt | null = null;
  #read = 0;
  #edge: Position | null = null;
  constructor(environmentId: EnvironmentId, ports: SpaceRootReorderPorts) {
    this.environmentId = environmentId;
    this.#ports = ports;
    this.#snapshot = {
      trash: null,
      recoveryPreview: null,
      blockSelection: null,
      hydrated: false,
      busy: false,
      window: null,
      position: null,
      spaces: null,
      parentPageId: null,
      body: null,
      error: null,
      notice: null,
      journal: { version: 1, environmentId, pending: null, history: null },
    };
  }
  getSnapshot = () => this.#snapshot;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  #update(patch: Partial<Snapshot>) {
    this.#snapshot = Object.freeze({
      ...this.#snapshot,
      ...patch,
      ...(patch.journal ? { journal: freeze(copy(patch.journal)) } : {}),
    });
    for (const l of this.#listeners) l();
  }
  assertReady() {
    if (!this.#snapshot.hydrated)
      throw new Error("Structural recovery must load before document editing");
  }
  hydrate(): Promise<void> {
    if (this.#ready) return this.#ready;
    this.#ready = (async () => {
      const stored = await this.#ports.store.load(this.environmentId);
      const journal = stored
        ? decodeSpaceStructureJournal(stored, this.environmentId)
        : this.#snapshot.journal;
      if (journal.pending && !journal.pending.conflict)
        this.#release = this.#ports.reserve(
          journal.pending.observed.pages.map((p) => p.pageId),
          true,
        );
      this.#update({ hydrated: true, journal, error: null });
    })().catch((error: unknown) => {
      this.#ready = null;
      this.#update({ error });
      throw error;
    });
    return this.#ready;
  }
  async browse(
    spaceId: C.SpaceId,
    pageId: C.SpacePageId,
    next = false,
    parentPageId: C.SpacePageId | null = null,
  ): Promise<void> {
    await this.hydrate();
    this.#ports.assertAccess(false);
    if (this.#work || this.#snapshot.busy || this.#snapshot.journal.pending)
      throw new Error("Resolve the retained placement first");
    const old = this.#snapshot.window;
    const cursor =
      next && old?.space.id === spaceId && this.#snapshot.parentPageId === parentPageId
        ? old.nextCursor
        : null;
    if (next && !cursor) throw new Error("No next root window");
    const request = ++this.#read;
    this.#update({ busy: true, error: null });
    try {
      const window = await this.#ports.list({
        environmentId: this.environmentId,
        spaceId,
        ...(parentPageId ? { parentPageId } : {}),
        limit: Math.min(50, this.#ports.maxRows()),
        ...(cursor ? { cursor } : {}),
      });
      if (request !== this.#read) return;
      let position = this.#snapshot.position;
      if (
        position?.pageId !== pageId ||
        (position.location.kind === "root" &&
          position.location.spaceId === spaceId &&
          position.rootRevision !== window.space.rootOrderRevision)
      )
        position = null;
      if (parentPageId === null) {
        if (
          next &&
          this.#edge?.pageId === pageId &&
          this.#edge.location.spaceId === spaceId &&
          this.#edge.rootRevision === window.space.rootOrderRevision &&
          (window.items[0] || window.nextCursor === null)
        ) {
          position = {
            ...this.#edge,
            beforePageId: window.items[0]?.id ?? null,
            destination: { kind: "root", spaceId, beforePageId: window.items[0]?.id ?? null },
          };
          this.#edge = null;
        }
        if (!next || this.#edge?.rootRevision !== window.space.rootOrderRevision) this.#edge = null;
        const index = window.items.findIndex((p) => p.id === pageId),
          page = window.items[index],
          successor = window.items[index + 1];
        if (page?.location?.kind === "root") {
          const found: Position = {
            pageId,
            revision: page.revision,
            rootRevision: window.space.rootOrderRevision,
            beforePageId: successor?.id ?? null,
            location: page.location,
            destination: { kind: "root", spaceId, beforePageId: successor?.id ?? null },
            guards: {
              pages: [{ pageId, revision: page.revision }],
              roots: [{ spaceId, rootOrderRevision: window.space.rootOrderRevision }],
            },
          };
          if (successor || window.nextCursor === null) position = found;
          else this.#edge = found;
        }
      }
      this.#update({ window: copy(window), parentPageId, position });
    } catch (error) {
      if (request === this.#read) this.#update({ error });
      throw error;
    } finally {
      if (request === this.#read) this.#update({ busy: false });
    }
  }
  async browseSpaces(next = false) {
    await this.hydrate();
    this.#ports.assertAccess(false);
    if (this.#work || this.#snapshot.busy || this.#snapshot.journal.pending)
      throw new Error("Resolve the retained placement first");
    const cursor = next ? this.#snapshot.spaces?.nextCursor : null;
    if (next && !cursor) throw new Error("No next space window");
    this.#update({ busy: true, error: null });
    try {
      this.#update({
        spaces: copy(
          await this.#ports.spaces({
            environmentId: this.environmentId,
            limit: Math.min(50, this.#ports.maxRows()),
            ...(cursor ? { cursor } : {}),
          }),
        ),
      });
    } catch (error) {
      this.#update({ error });
      throw error;
    } finally {
      this.#update({ busy: false });
    }
  }
  async #body(pageId: C.SpacePageId) {
    const metadata = await this.#ports.getPage(pageId);
    const blocks = await this.#ports.blocks({
      environmentId: this.environmentId,
      pageId,
      revision: metadata.page.revision,
      limit: 100,
    });
    if (blocks.revision !== metadata.page.revision) throw new Error("The placement body changed");
    spaceJsonBytes(blocks, 512 * 1024);
    return { pageId, spaceId: metadata.page.spaceId, ...blocks };
  }
  loadSource(pageId: C.SpacePageId) {
    return this.#exclusive(async () => {
      const source = await this.#ports.getPage(pageId);
      const location = source.page.location;
      if (!location) throw new Error("Current source ownership is unavailable");
      this.#update({ position: null });
      if (location.kind === "root") {
        this.#update({
          notice: "Use First / Next roots in the source space to prove its original successor.",
        });
        return;
      }
      const body = await this.#body(location.parentPageId);
      if (body.nextCursor !== null)
        throw new Error(
          "The source parent body is partial; its original list placement cannot be proven in this slice",
        );
      const owner = body.blocks.find((b) => b.id === location.ownerBlockId);
      if (
        !owner ||
        owner.type !== "child_page" ||
        owner.version !== 1 ||
        typeof owner.content !== "object" ||
        owner.content === null ||
        Array.isArray(owner.content) ||
        !("pageId" in owner.content) ||
        owner.content.pageId !== pageId ||
        (owner.parentId !== null &&
          !body.blocks.some((b) => b.id === owner.parentId && isSpaceListItem(b)))
      )
        throw new Error("The actual source owner row or known list container is unavailable");
      const siblings = body.blocks.filter((b) => b.parentId === owner.parentId),
        index = siblings.findIndex((b) => b.id === owner.id);
      const destination: Destination = {
        kind: "child",
        placement: {
          pageId: body.pageId,
          parentId: owner.parentId,
          beforeBlockId: siblings[index + 1]?.id ?? null,
        },
      };
      this.#update({
        position: {
          pageId,
          revision: source.page.revision,
          rootRevision: source.space.rootOrderRevision,
          beforePageId: null,
          location,
          destination,
          guards: {
            pages: [
              { pageId, revision: source.page.revision },
              { pageId: body.pageId, revision: body.revision },
            ],
            roots: [],
          },
        },
        notice: "Original owner and successor are proven.",
      });
    });
  }
  loadBody(pageId: C.SpacePageId) {
    return this.#exclusive(async () => {
      this.#update({ body: null });
      this.#update({ body: copy(await this.#body(pageId)) });
    });
  }
  #assertRecovery(write: boolean) {
    this.#ports.assertAccess(write);
    const c = this.#ports.capability();
    if (c?.version !== 2 || c.features?.recovery !== true)
      throw new Error("Page recovery is unsupported by this environment");
  }
  browseTrash(next = false) {
    return this.#exclusive(async () => {
      this.#assertRecovery(false);
      const cursor = next ? this.#snapshot.trash?.nextCursor : null;
      if (next && !cursor) throw new Error("No next trash window");
      const trash = await this.#ports.trashList({
        environmentId: this.environmentId,
        limit: Math.min(50, this.#ports.maxRows()),
        ...(cursor ? { cursor } : {}),
      });
      this.#update({ trash: copy(trash), recoveryPreview: null });
    }, false);
  }
  previewRecovery(pageId: C.SpacePageId, operation: C.SpaceRecoveryOperation) {
    return this.#exclusive(async () => {
      this.#assertRecovery(false);
      this.#update({ recoveryPreview: null });
      const inspection = await this.#ports.inspect({
        environmentId: this.environmentId,
        target: { kind: "page", pageId },
        recovery: operation,
      });
      guards(inspection.guards);
      const selected = inspection.recovery?.pageIds;
      const page = inspection.pages.find((p) => p.id === pageId);
      if (
        !page ||
        inspection.recovery?.operation !== operation ||
        !selected?.includes(pageId) ||
        selected.length > 8 ||
        new Set(selected).size !== selected.length ||
        !selected.every((id) => inspection.guards.pages.some((g) => g.pageId === id))
      )
        throw new Error("No complete bounded recovery selection is available");
      const location = page.location;
      const parent =
        location?.kind === "child"
          ? inspection.pages.find((p) => p.id === location.parentPageId)
          : null;
      const placement =
        operation === "permanentlyDelete"
          ? "Permanently delete the entire inspected current trashed subtree, including independent batches within it. This is irreversible; there is no Undo."
          : operation === "trash"
            ? "Hide the selected current subtree. Independently trashed batches stay separate."
            : location?.kind === "root"
              ? `Restore at its current root placement in space ${location.spaceId}.`
              : location?.kind === "child" && parent && !parent.trash
                ? `Restore under current parent ${parent.id}; preserve its existing owner marker.`
                : "Restore at the original surviving space root because the current owner is unavailable or still in trash. No retired marker is revived.";
      this.#update({ recoveryPreview: freeze(copy({ pageId, operation, inspection, placement })) });
    }, false);
  }
  confirmRecovery(preview: SpaceRecoveryPreview, confirmPermanentDeletion = false) {
    return this.#exclusive(async () => {
      this.#assertRecovery(true);
      if (this.#snapshot.recoveryPreview !== preview)
        throw new Error("Inspect the current recovery selection first");
      if (preview.operation === "permanentlyDelete" && !confirmPermanentDeletion)
        throw new Error("Permanent deletion requires explicit irreversible confirmation");
      const observed = preview.inspection.guards;
      await this.#stage(observed, async () => {
        const admission = await this.#ports.spaces({ environmentId: this.environmentId, limit: 1 });
        this.#assertRecovery(true);
        return {
          request: {
            operation:
              preview.operation === "trash"
                ? "trashPage"
                : preview.operation === "restore"
                  ? "restorePage"
                  : "permanentlyDeletePage",
            input: {
              environmentId: this.environmentId,
              pageId: preview.pageId,
              guards: observed,
              mutationId: C.SpaceMutationId.make(this.#ports.newId()),
              receiptEpoch: admission.mutationAdmission.epoch,
            },
          },
          recoveryPageIds: preview.inspection.recovery!.pageIds,
          recoveryBefore: preview.inspection.pages,
          recoveryScope: "page recovery",
          inverse: null,
          observed,
          direction: "move",
          conflict: false,
        };
      });
    });
  }
  createChild(title: string, placement: C.SpaceBlockPlacement) {
    return this.#exclusive(async () => {
      const capability = this.#ports.capability();
      if (capability?.version !== 2)
        throw new Error("Child creation requires a known v2 environment");
      spaceJsonBytes(title, capability.limits.maxTitleBytes);
      const body = this.#snapshot.body;
      if (
        !body ||
        body.pageId !== placement.pageId ||
        body.nextCursor !== null ||
        (placement.parentId !== null &&
          !body.blocks.some((b) => b.id === placement.parentId && isSpaceListItem(b))) ||
        (placement.beforeBlockId !== null &&
          !body.blocks.some(
            (b) => b.id === placement.beforeBlockId && b.parentId === placement.parentId,
          ))
      )
        throw new Error("Load a complete parent body and known list placement first");
      const inspection = await this.#ports.inspect({
        environmentId: this.environmentId,
        target: { kind: "blocks", pageId: placement.pageId, blockIds: [] },
        destination: { kind: "child", placement },
      });
      guards(inspection.guards);
      if (
        inspection.guards.pages.length >= 8 ||
        inspection.guards.pages.find((p) => p.pageId === body.pageId)?.revision !== body.revision
      )
        throw new Error("The complete parent changed or creation exceeds eight affected pages");
      await this.#prepareIntent(placement.pageId, inspection.guards, (admission) => {
        if (admission.page.revision !== body.revision)
          throw new Error("The parent changed; reload placement");
        return {
          request: {
            operation: "createChildPage",
            input: {
              environmentId: this.environmentId,
              title,
              placement,
              guards: inspection.guards,
              mutationId: C.SpaceMutationId.make(this.#ports.newId()),
              receiptEpoch: admission.mutationAdmission.epoch,
            },
          },
          targetSpaceId: body.spaceId,
          knownBlockIds: [...new Set([...body.blocks.map((b) => b.id), ...inspection.blockIds])],
          inverse: null,
          observed: {
            ...inspection.guards,
            roots: inspection.guards.roots.some((r) => r.spaceId === admission.space.id)
              ? inspection.guards.roots
              : [
                  ...inspection.guards.roots,
                  {
                    spaceId: admission.space.id,
                    rootOrderRevision: admission.space.rootOrderRevision,
                  },
                ],
          },
          direction: "move",
          conflict: false,
        };
      });
    });
  }
  move(pageId: C.SpacePageId, spaceId: C.SpaceId, beforePageId: C.SpacePageId | null) {
    return this.moveTo(pageId, { kind: "root", spaceId, beforePageId });
  }
  moveTo(pageId: C.SpacePageId, destination: Destination) {
    return this.#exclusive(async () => {
      const { window, position, body, parentPageId } = this.#snapshot;
      if (!position || position.pageId !== pageId)
        throw new Error("Load the original position and a proven destination window first");
      if (destination.kind === "root") {
        if (
          !window ||
          parentPageId !== null ||
          window.space.id !== destination.spaceId ||
          destination.beforePageId === pageId ||
          (destination.beforePageId === null
            ? window.nextCursor !== null
            : !window.items.some((p) => p.id === destination.beforePageId))
        )
          throw new Error("Load the original position and a proven destination window first");
      } else {
        const p = destination.placement;
        if (
          !body ||
          body.pageId !== p.pageId ||
          body.nextCursor !== null ||
          (p.parentId !== null &&
            !body.blocks.some((b) => b.id === p.parentId && isSpaceListItem(b))) ||
          (p.beforeBlockId !== null &&
            !body.blocks.some((b) => b.id === p.beforeBlockId && b.parentId === p.parentId))
        )
          throw new Error(
            "Load a complete bounded destination body and known list placement first",
          );
      }
      const forward = await this.#inspect(pageId, destination),
        back = await this.#inspect(pageId, position.destination);
      const overlap = {
        pages: back.guards.pages.filter((p) =>
          forward.guards.pages.some((f) => f.pageId === p.pageId),
        ),
        roots: back.guards.roots.filter((p) =>
          forward.guards.roots.some((f) => f.spaceId === p.spaceId),
        ),
      };
      const proof: C.SpaceStructureGuards =
        destination.kind === "root"
          ? {
              pages: [],
              roots: [
                { spaceId: window!.space.id, rootOrderRevision: window!.space.rootOrderRevision },
              ],
            }
          : { pages: [{ pageId: body!.pageId, revision: body!.revision }], roots: [] };
      const source = forward.pages.find((p) => p.id === pageId)!;
      if (
        !covered(forward.guards, overlap) ||
        !covered(forward.guards, position.guards) ||
        !covered(forward.guards, proof) ||
        !source.location ||
        !sameLocation(position.location, source.location)
      )
        throw new Error("Page placement changed; load its position again");
      const observed = merge(forward.guards, back.guards);
      guards(observed);
      const targetSpaceId = destination.kind === "root" ? destination.spaceId : body!.spaceId;
      await this.#prepare(
        pageId,
        destination,
        position.destination,
        forward.guards,
        observed,
        "move",
        targetSpaceId,
        position.location,
      );
    });
  }
  #assertBlocks(write: boolean) {
    this.#ports.assertAccess(write);
    const capability = this.#ports.capability();
    if (capability?.version !== 2 || capability.features?.blockMoves !== true)
      throw new Error(
        "This environment does not advertise block moves; update it before moving blocks",
      );
  }
  async selectBlocks(
    sourcePageId: C.SpacePageId,
    revision: number,
    selected: readonly C.SpaceBlockId[],
  ) {
    await this.#exclusive(async () => {
      this.#assertBlocks(false);
      const body = await this.#body(sourcePageId);
      if (body.revision !== revision || body.nextCursor !== null)
        throw new Error("Block moves require the current complete source window");
      const ids = new Set(selected),
        byId = new Map(body.blocks.map((b) => [b.id, b]));
      if (
        ids.size !== selected.length ||
        ids.size < 1 ||
        ids.size > 100 ||
        selected.some((id) => !byId.has(id))
      )
        throw new Error("Invalid selected roots");
      const roots = body.blocks.filter((b) => ids.has(b.id));
      const parentId = roots[0]!.parentId,
        siblings = body.blocks.filter((b) => b.parentId === parentId);
      const start = siblings.findIndex((b) => b.id === roots[0]!.id);
      if (
        selected.some((id, i) => roots[i]?.id !== id) ||
        roots.some(
          (b) =>
            b.parentId !== null &&
            !body.blocks.some((parent) => parent.id === b.parentId && isSpaceListItem(parent)),
        )
      )
        throw new Error("Selected roots must follow document order and use permitted parent lists");
      const contiguous = roots.every(
        (b, i) => b.parentId === parentId && siblings[start + i]?.id === b.id,
      );
      const selectedIds = new Set(roots.map((b) => b.id));
      for (const block of body.blocks)
        if (block.parentId && selectedIds.has(block.parentId)) selectedIds.add(block.id);
      if (roots.some((b) => b.parentId !== null && selectedIds.has(b.parentId)))
        throw new Error("Select subtree roots, not both ancestor and descendant");
      const before = siblings[start - 1],
        parent = parentId === null ? undefined : byId.get(parentId);
      const parentPeers = parent ? body.blocks.filter((b) => b.parentId === parent.parentId) : [];
      const proof: SpaceBlockMoveProof = freeze({
        sourcePageId,
        revision,
        blockIds: roots.map((b) => b.id),
        selectedIds: [...selectedIds],
        inverse: contiguous
          ? {
              pageId: sourcePageId,
              parentId,
              beforeBlockId: siblings[start + roots.length]?.id ?? null,
            }
          : null,
        indent:
          contiguous && before && isSpaceListItem(before)
            ? { pageId: sourcePageId, parentId: before.id, beforeBlockId: null }
            : null,
        outdent:
          contiguous && parent
            ? {
                pageId: sourcePageId,
                parentId: parent.parentId,
                beforeBlockId:
                  parentPeers[parentPeers.findIndex((b) => b.id === parent.id) + 1]?.id ?? null,
              }
            : null,
      });
      this.#update({ blockSelection: proof, body, position: null });
    });
    return this.#snapshot.blockSelection!;
  }
  moveSelectedBlocks(proof: SpaceBlockMoveProof, destination: C.SpaceBlockPlacement) {
    return this.#exclusive(async () => {
      this.#assertBlocks(true);
      if (this.#snapshot.blockSelection !== proof)
        throw new Error("The selected move roots changed; select them again");
      const body = this.#snapshot.body;
      if (
        !body ||
        body.pageId !== destination.pageId ||
        body.nextCursor !== null ||
        (destination.parentId !== null &&
          !body.blocks.some((b) => b.id === destination.parentId && isSpaceListItem(b))) ||
        (destination.beforeBlockId !== null &&
          !body.blocks.some(
            (b) => b.id === destination.beforeBlockId && b.parentId === destination.parentId,
          ))
      )
        throw new Error("Block moves require a complete destination body and known list placement");
      if (
        proof.sourcePageId === destination.pageId &&
        ((destination.parentId && proof.selectedIds.includes(destination.parentId)) ||
          (destination.beforeBlockId && proof.selectedIds.includes(destination.beforeBlockId)))
      )
        throw new Error("The destination intersects the selected subtree");
      const forward = await this.#inspectBlocks(proof.sourcePageId, proof.blockIds, destination);
      const back = proof.inverse
        ? await this.#inspectBlocks(proof.sourcePageId, proof.blockIds, proof.inverse)
        : forward;
      const shared = {
        pages: back.guards.pages.filter((p) =>
          forward.guards.pages.some((f) => f.pageId === p.pageId),
        ),
        roots: back.guards.roots.filter((p) =>
          forward.guards.roots.some((f) => f.spaceId === p.spaceId),
        ),
      };
      if (
        !covered(forward.guards, shared) ||
        forward.guards.pages.find((p) => p.pageId === proof.sourcePageId)?.revision !==
          proof.revision ||
        forward.guards.pages.find((p) => p.pageId === body.pageId)?.revision !== body.revision
      )
        throw new Error("The selected subtree or destination changed");
      const observed = merge(forward.guards, back.guards);
      guards(observed);
      await this.#prepareBlocks(
        proof.sourcePageId,
        proof.blockIds,
        destination,
        proof.inverse,
        forward.guards,
        observed,
        "move",
      );
    });
  }
  async #inspectBlocks(
    sourcePageId: C.SpacePageId,
    blockIds: readonly C.SpaceBlockId[],
    destination: C.SpaceBlockPlacement,
  ) {
    this.#assertBlocks(false);
    const result = await this.#ports.inspect({
      environmentId: this.environmentId,
      target: { kind: "blocks", pageId: sourcePageId, blockIds },
      destination: { kind: "child", placement: destination },
    });
    guards(result.guards);
    return result;
  }
  compensate(direction: "undo" | "redo") {
    return this.#exclusive(async () => {
      const h = this.#snapshot.journal.history;
      if (!h || h.direction !== direction)
        throw new Error("No guarded placement is retained for this direction");
      if (!("destination" in h)) {
        this.#assertRecovery(true);
        let inspected: C.SpaceInspectStructureResult;
        try {
          inspected = await this.#ports.inspect({
            environmentId: this.environmentId,
            target: { kind: "page", pageId: h.pageId },
            recovery: h.operation === "trashPage" ? "trash" : "restore",
          });
        } catch {
          throw new Error(
            "The retained recovery inverse is unavailable; inspect a new action explicitly",
          );
        }
        if (
          !sameIds(inspected.recovery?.pageIds ?? [], h.pageIds) ||
          !sameRecoveryContext(inspected.pages, h.pages) ||
          !sameIds(
            inspected.guards.roots.map((r) => r.spaceId),
            h.guards.roots.map((r) => r.spaceId),
          )
        )
          throw new Error(
            "The retained recovery closure, ownership or batch changed; inverse is unavailable",
          );
        await this.#stage(h.observed, async () => {
          const admission = await this.#ports.spaces({
            environmentId: this.environmentId,
            limit: 1,
          });
          this.#assertRecovery(true);
          return {
            request: {
              operation: h.operation,
              input: {
                environmentId: this.environmentId,
                pageId: h.pageId,
                guards: h.guards,
                mutationId: C.SpaceMutationId.make(this.#ports.newId()),
                receiptEpoch: admission.mutationAdmission.epoch,
              },
            },
            recoveryPageIds: h.pageIds,
            recoveryBefore: h.pages,
            recoveryScope: h.scope,
            observed: h.observed,
            inverse: null,
            direction,
            conflict: false,
          };
        });
        return;
      }
      let current: C.SpaceInspectStructureResult;
      try {
        current =
          h.operation === "moveBlocks" && h.blockIds && h.destination.kind === "child"
            ? await this.#inspectBlocks(h.pageId, h.blockIds, h.destination.placement)
            : await this.#inspect(h.pageId, h.destination);
      } catch {
        throw new Error(
          "The retained inverse placement is unavailable; inspect a new move explicitly",
        );
      }
      if (
        current.guards.pages.length !== h.guards.pages.length ||
        current.guards.roots.length !== h.guards.roots.length ||
        !current.guards.pages.every((p) => h.guards.pages.some((k) => k.pageId === p.pageId)) ||
        !current.guards.roots.every((p) => h.guards.roots.some((k) => k.spaceId === p.spaceId))
      )
        throw new Error("The retained inverse closure changed; inspect a new move explicitly");
      if (
        h.operation === "moveBlocks" &&
        h.blockIds &&
        h.destination.kind === "child" &&
        h.opposite.kind === "child"
      ) {
        await this.#prepareBlocks(
          h.pageId,
          h.blockIds,
          h.destination.placement,
          h.opposite.placement,
          h.guards,
          h.observed,
          direction,
        );
        return;
      }
      await this.#prepare(
        h.pageId,
        h.destination,
        h.opposite,
        h.guards,
        h.observed,
        direction,
        h.targetSpaceId,
        h.sourceLocation,
      );
    });
  }
  async #inspect(pageId: C.SpacePageId, destination: Destination) {
    const result = await this.#ports.inspect({
      environmentId: this.environmentId,
      target: { kind: "page", pageId },
      destination,
    });
    guards(result.guards);
    if (!result.pages.find((p) => p.id === pageId)?.location)
      throw new Error("Current page ownership is unavailable");
    return result;
  }
  #exclusive(use: () => Promise<void>, write = true): Promise<void> {
    if (this.#work) return Promise.reject(new Error("Another placement operation is in progress"));
    const work = (async () => {
      await this.hydrate();
      this.#ports.assertAccess(write);
      if (this.#snapshot.busy) throw new Error("Wait for the current root window");
      if (this.#snapshot.journal.pending) throw new Error("Resolve the retained placement first");
      this.#update({ busy: true, error: null, notice: null });
      await use();
    })()
      .catch((error: unknown) => {
        this.#update({ error });
        throw error;
      })
      .finally(() => {
        this.#update({ busy: false });
        if (this.#work === work) this.#work = null;
      });
    this.#work = work;
    return work;
  }
  async #prepare(
    pageId: C.SpacePageId,
    destination: Destination,
    inverse: Destination,
    expected: C.SpaceStructureGuards,
    observed: C.SpaceStructureGuards,
    direction: Pending["direction"],
    targetSpaceId?: C.SpaceId,
    sourceLocation?: C.SpacePageLocation,
  ) {
    await this.#prepareIntent(pageId, observed, (admission) => {
      const expectedLocation =
        sourceLocation ??
        (inverse.kind === "root"
          ? { kind: "root" as const, spaceId: inverse.spaceId, order: "" }
          : null);
      if (
        !expectedLocation ||
        !admission.page.location ||
        !sameLocation(expectedLocation, admission.page.location)
      )
        throw new Error("Source ownership changed; inspect a new intent explicitly");
      return {
        ...(targetSpaceId ? { targetSpaceId } : {}),
        ...(sourceLocation ? { sourceLocation } : {}),
        request: {
          operation: "movePage",
          input: {
            environmentId: this.environmentId,
            pageId,
            mutationId: C.SpaceMutationId.make(this.#ports.newId()),
            receiptEpoch: admission.mutationAdmission.epoch,
            destination,
            guards: expected,
          },
        },
        inverse,
        observed,
        direction,
        conflict: false,
      };
    });
  }
  async #prepareBlocks(
    sourcePageId: C.SpacePageId,
    blockIds: readonly C.SpaceBlockId[],
    destination: C.SpaceBlockPlacement,
    inverse: C.SpaceBlockPlacement | null,
    expected: C.SpaceStructureGuards,
    observed: C.SpaceStructureGuards,
    direction: Pending["direction"],
  ) {
    this.#assertBlocks(true);
    await this.#prepareIntent(sourcePageId, observed, (admission) => ({
      request: {
        operation: "moveBlocks",
        input: {
          environmentId: this.environmentId,
          sourcePageId,
          blockIds,
          destination,
          guards: expected,
          mutationId: C.SpaceMutationId.make(this.#ports.newId()),
          receiptEpoch: admission.mutationAdmission.epoch,
        },
      },
      inverse: inverse ? { kind: "child", placement: inverse } : null,
      observed,
      direction,
      conflict: false,
    }));
  }
  async #prepareIntent(
    pageId: C.SpacePageId,
    observed: C.SpaceStructureGuards,
    make: (admission: C.SpacePageGetResult) => Pending,
  ) {
    return this.#stage(observed, async () => make(await this.#ports.getPage(pageId)));
  }
  async #stage(observed: C.SpaceStructureGuards, make: () => Promise<Pending>) {
    this.#release = this.#ports.reserve(
      observed.pages.map((p) => p.pageId),
      false,
    );
    try {
      await this.#ports.checkDrafts(observed.pages.map((p) => p.pageId));
      const pending = await make();
      this.#ports.assertAccess(true);
      spaceJsonBytes(pending.request, Math.min(1024 * 1024, this.#ports.maxMutationBytes()));
      const journal = decodeSpaceStructureJournal(
        { ...this.#snapshot.journal, pending },
        this.environmentId,
      );
      this.#unsent = true;
      this.#update({ journal: copy(journal) });
      await this.#persist();
      await this.#send();
    } catch (error) {
      if (!this.#snapshot.journal.pending) this.#unlock();
      throw error;
    }
  }
  async #persist() {
    await this.#ports.store.write(this.environmentId, copy(this.#snapshot.journal));
  }
  #unlock() {
    this.#release?.();
    this.#release = null;
  }
  async #send() {
    const pending = this.#snapshot.journal.pending!;
    this.#ports.assertAccess(true);
    this.#unsent = false;
    const request = pending.request;
    if (request.operation === "moveBlocks") {
      this.#assertBlocks(true);
      await this.#ack({
        operation: "moveBlocks",
        result: await this.#ports.moveBlocks(copy(request.input)),
      });
    } else if (request.operation === "createChildPage") {
      await this.#ack({
        operation: "createChildPage",
        result: await this.#ports.createChild(copy(request.input)),
      });
    } else if (request.operation === "permanentlyDeletePage") {
      this.#assertRecovery(true);
      let result: C.SpacePagePurgeResult;
      try {
        result = await this.#ports.purge(copy(request.input));
      } catch (error) {
        if (
          !isValidationError(error) ||
          (error.reason !== "invalid_input" && error.reason !== "invalid_recovery_state")
        )
          throw error;
        const journal = decodeSpaceStructureJournal(
          {
            ...this.#snapshot.journal,
            pending: { ...pending, conflict: true, rejection: error.reason },
          },
          this.environmentId,
        );
        await this.#ports.store.write(this.environmentId, journal);
        this.#update({
          journal,
          notice:
            "The server rejected permanent deletion before committing because the inspected selection or trash state is no longer valid. The exact attempted intent is retained; inspect explicitly to start a new intent.",
        });
        this.#unlock();
        return;
      }
      await this.#ack({ operation: "permanentlyDeletePage", result });
    } else if (request.operation === "trashPage" || request.operation === "restorePage") {
      this.#assertRecovery(true);
      await this.#ack({
        operation: request.operation,
        result: await this.#ports.recovery(request.operation, copy(request.input)),
      });
    } else
      await this.#ack({
        operation: "movePage",
        result: await this.#ports.move(copy(request.input)),
      });
  }
  recover(): Promise<void> {
    if (this.#work) return Promise.reject(new Error("Another placement operation is in progress"));
    const work = (async () => {
      await this.hydrate();
      this.#ports.assertAccess(false);
      if (this.#snapshot.busy) throw new Error("Wait for the current root window");
      const p = this.#snapshot.journal.pending;
      if (!p || p.conflict) throw new Error("No uncertain placement to recover");
      if (p.request.operation === "moveBlocks") this.#assertBlocks(false);
      this.#update({ busy: true, error: null });
      if (this.#accepted) {
        await this.#ack(this.#accepted);
        return;
      }
      await this.#persist();
      if (this.#unsent) {
        await this.#send();
        return;
      }
      const receipt = await this.#ports.receipt({ request: copy(p.request) });
      if (receipt.status === "unknown") {
        this.#update({
          notice:
            "Receipt expired or unknown. The exact placement is retained; it cannot be reissued.",
        });
        return;
      }
      if (receipt.status === "found") {
        if (
          receipt.receipt.operation !== p.request.operation ||
          (receipt.receipt.operation !== "movePage" &&
            receipt.receipt.operation !== "moveBlocks" &&
            receipt.receipt.operation !== "createChildPage" &&
            receipt.receipt.operation !== "trashPage" &&
            receipt.receipt.operation !== "restorePage" &&
            receipt.receipt.operation !== "permanentlyDeletePage")
        )
          throw new Error("Mismatched structural receipt operation");
        await this.#ack(receipt.receipt);
      } else await this.#send();
    })()
      .catch((error: unknown) => {
        this.#update({ error });
        throw error;
      })
      .finally(() => {
        this.#update({ busy: false });
        if (this.#work === work) this.#work = null;
      });
    this.#work = work;
    return work;
  }
  async #recoveryHistory(
    p: Pending,
    receipt: MoveReceipt,
    observed: C.SpaceStructureGuards,
  ): Promise<typeof recoveryHistory.Type> {
    const created =
      receipt.operation === "createChildPage" && receipt.result.status === "saved"
        ? receipt.result.page
        : null;
    if (!created && p.request.operation !== "trashPage" && p.request.operation !== "restorePage")
      throw new Error("No recovery inverse");
    const pageId = created ? created.id : (p.request.input as C.SpacePageRecoveryInput).pageId;
    const operation =
      p.request.operation === "trashPage" ? ("restorePage" as const) : ("trashPage" as const);
    const inspected = await this.#ports.inspect({
      environmentId: this.environmentId,
      target: { kind: "page", pageId },
      recovery: operation === "trashPage" ? "trash" : "restore",
    });
    guards(inspected.guards);
    const pageIds = created ? [created.id] : (p.recoveryPageIds ?? []);
    if (
      !sameIds(inspected.recovery?.pageIds ?? [], pageIds) ||
      !covered(observed, inspected.guards)
    )
      throw new Error(
        "Recovery accepted. Undo is unavailable because the complete inverse guards or current closure are not proven.",
      );
    const before = created
      ? [created]
      : p.recoveryBefore?.filter((page) => pageIds.includes(page.id));
    if (
      !before ||
      !before.every((page) => {
        const now = inspected.pages.find((row) => row.id === page.id);
        return (
          !!now && !!page.location && !!now.location && sameLocation(page.location, now.location)
        );
      })
    )
      throw new Error(
        "Recovery accepted. Undo is unavailable because restore changed placement or original ownership is unproven.",
      );
    return {
      operation,
      scope: created ? "created child" : (p.recoveryScope ?? "page recovery"),
      pageId,
      pageIds,
      pages: inspected.pages,
      guards: inspected.guards,
      observed,
      direction: p.direction === "undo" ? "redo" : "undo",
    };
  }
  async #ack(receipt: MoveReceipt) {
    const p = this.#snapshot.journal.pending!,
      result = receipt.result;
    if (
      receipt.operation !== p.request.operation ||
      result.mutationId !== p.request.input.mutationId ||
      result.receiptEpoch !== p.request.input.receiptEpoch
    )
      throw new Error("Mismatched structural receipt identity");
    if (result.status === "conflict") {
      this.#accepted = receipt;
      const journal = { ...this.#snapshot.journal, pending: { ...p, conflict: true } };
      await this.#ports.store.write(this.environmentId, journal);
      this.#update({
        journal,
        notice:
          "Placement conflicted. The attempted placement is retained. Reinspect explicitly to start a new intent.",
      });
      this.#accepted = null;
      this.#unlock();
      return;
    }
    if (
      receipt.operation === "moveBlocks" &&
      receipt.result.status === "saved" &&
      p.request.operation === "moveBlocks"
    ) {
      const input = p.request.input;
      if (
        (result.changed.pages.length || result.changed.roots.length) &&
        ![input.sourcePageId, input.destination.pageId].every((pageId) =>
          result.changed.pages.some((row) => row.pageId === pageId),
        )
      )
        throw new Error("Missing affected block-owner acknowledgement");
      if (
        receipt.result.blockIds.length !== p.request.input.blockIds.length ||
        !receipt.result.blockIds.every(
          (id, i) => id === (p.request.input as C.SpaceMoveBlocksInput).blockIds[i],
        )
      )
        throw new Error("Mismatched acknowledged selected roots");
    } else if (
      receipt.operation === "movePage" &&
      receipt.result.status === "saved" &&
      p.request.operation === "movePage"
    ) {
      const r = receipt.result,
        d = p.request.input.destination,
        location = r.page.location;
      const targetSpaceId = p.targetSpaceId ?? (d.kind === "root" ? d.spaceId : null);
      if (
        r.page.id !== p.request.input.pageId ||
        !location ||
        r.page.spaceId !== targetSpaceId ||
        (d.kind === "root"
          ? location.kind !== "root" || r.ownerBlockId !== null
          : location.kind !== "child" ||
            location.parentPageId !== d.placement.pageId ||
            !r.ownerBlockId ||
            location.ownerBlockId !== r.ownerBlockId ||
            (p.sourceLocation?.kind === "child" &&
              p.sourceLocation.ownerBlockId !== r.ownerBlockId))
      )
        throw new Error("Mismatched structural receipt page or owner");
    }
    const created =
      receipt.operation === "createChildPage" && receipt.result.status === "saved"
        ? receipt.result
        : null;
    if (created && p.request.operation === "createChildPage") {
      const input = p.request.input,
        location = created.page.location;
      if (
        created.page.revision !== 0 ||
        created.page.trash ||
        created.page.title !== input.title ||
        created.page.spaceId !== p.targetSpaceId ||
        !location ||
        location.kind !== "child" ||
        location.parentPageId !== input.placement.pageId ||
        location.ownerBlockId !== created.ownerBlockId ||
        (created.ownerBlockId as string) === created.page.id ||
        p.knownBlockIds?.some(
          (id) => id === created.ownerBlockId || (id as string) === created.page.id,
        ) ||
        p.observed.pages.some(
          (g) => g.pageId === created.page.id || (created.ownerBlockId as string) === g.pageId,
        ) ||
        !result.changed.pages.some((g) => g.pageId === created.page.id && g.revision === 0) ||
        !result.changed.pages.some((g) => g.pageId === input.placement.pageId)
      )
        throw new Error("Mismatched server-generated child acknowledgement");
    }
    if (
      (receipt.operation === "trashPage" || receipt.operation === "restorePage") &&
      receipt.result.status === "saved" &&
      (p.request.operation === "trashPage" || p.request.operation === "restorePage")
    ) {
      if (
        receipt.result.page.id !== p.request.input.pageId ||
        (receipt.operation === "trashPage"
          ? !receipt.result.page.trash
          : !!receipt.result.page.trash) ||
        !p.recoveryPageIds?.every((id) => result.changed.pages.some((g) => g.pageId === id))
      )
        throw new Error("Mismatched recovery acknowledgement");
    }
    const deleted =
      receipt.operation === "permanentlyDeletePage" && receipt.result.status === "saved"
        ? receipt.result
        : null;
    if (
      deleted &&
      (p.request.operation !== "permanentlyDeletePage" ||
        deleted.pageId !== p.request.input.pageId ||
        !sameIds(deleted.deletedPageIds, p.recoveryPageIds ?? []) ||
        deleted.changed.pages.some((g) => deleted.deletedPageIds.includes(g.pageId)))
    )
      throw new Error("Mismatched permanent deletion acknowledgement");
    for (const row of result.changed.pages)
      if (
        !(created && row.pageId === created.page.id && row.revision === 0) &&
        !p.observed.pages.some((k) => k.pageId === row.pageId && row.revision === k.revision + 1)
      )
        throw new Error("Unobserved structural page acknowledgement");
    for (const row of result.changed.roots)
      if (
        !p.observed.roots.some(
          (k) => k.spaceId === row.spaceId && row.rootOrderRevision === k.rootOrderRevision + 1,
        )
      )
        throw new Error("Unobserved structural root acknowledgement");
    const observed = merge(p.observed, result.changed);
    const savedPage =
      "page" in receipt.result && receipt.result.status === "saved" ? receipt.result.page : null;
    if (
      new Set(result.changed.pages.map((p) => p.pageId)).size !== result.changed.pages.length ||
      new Set(result.changed.roots.map((p) => p.spaceId)).size !== result.changed.roots.length ||
      (savedPage &&
        observed.pages.find((p) => p.pageId === savedPage.id)?.revision !== savedPage.revision)
    )
      throw new Error("Inconsistent structural acknowledgement guards");
    this.#accepted = receipt;
    let history: SpaceStructureJournal["history"] = null,
      notice = "Placement accepted. No compensating placement could be retained.";
    if (result.changed.pages.length || result.changed.roots.length) {
      try {
        if (p.request.operation === "moveBlocks" && p.inverse?.kind === "child") {
          const input = p.request.input;
          const inverse = await this.#inspectBlocks(
            input.destination.pageId,
            input.blockIds,
            p.inverse.placement,
          );
          if (!covered(observed, inverse.guards))
            throw new Error("The inverse placement changed after acknowledgement");
          history = {
            operation: "moveBlocks",
            pageId: input.destination.pageId,
            blockIds: input.blockIds,
            destination: p.inverse,
            opposite: { kind: "child", placement: input.destination },
            guards: inverse.guards,
            observed,
            direction: p.direction === "undo" ? "redo" : "undo",
          };
        } else if (
          p.inverse &&
          p.request.operation === "movePage" &&
          receipt.operation === "movePage" &&
          receipt.result.status === "saved"
        ) {
          const input = p.request.input,
            location = receipt.result.page.location!;
          const inverse = await this.#inspect(input.pageId, p.inverse);
          if (!covered(observed, inverse.guards))
            throw new Error("The inverse placement changed after acknowledgement");
          history = {
            pageId: input.pageId,
            destination: p.inverse,
            opposite: input.destination,
            targetSpaceId:
              p.sourceLocation?.spaceId ??
              (p.inverse.kind === "root" ? p.inverse.spaceId : receipt.result.page.spaceId),
            sourceLocation: location,
            guards: inverse.guards,
            observed,
            direction: p.direction === "undo" ? "redo" : "undo",
          };
          if (p.sourceLocation && p.sourceLocation.kind !== location.kind)
            notice =
              "Root/child undo restores page placement, not retired owner-marker IDs or their links.";
        }
        if (p.request.operation === "moveBlocks" && !p.inverse)
          notice =
            "Placement accepted. Undo is unavailable because the roots came from multiple original placements.";
        if (history)
          notice =
            "Placement accepted. One guarded placement undo/redo is retained. " +
            (notice.startsWith("Root/child") ? notice : "");
      } catch (error) {
        notice = error instanceof Error ? error.message : notice;
      }
    } else {
      if (p.direction === "move") history = this.#snapshot.journal.history;
      notice = "The selection was already in that position.";
    }
    if (
      p.request.operation === "createChildPage" ||
      p.request.operation === "trashPage" ||
      p.request.operation === "restorePage"
    ) {
      history = null;
      try {
        this.#assertRecovery(false);
        history = await this.#recoveryHistory(p, receipt, observed);
        notice = `Accepted. One guarded recovery ${history.direction} is retained for the last bounded ${history.scope} action; it changes visibility only, not content or placement. Trashing allocates a new batch.`;
      } catch (error) {
        notice = `Accepted. Undo is unavailable. ${error instanceof Error ? error.message : "The inverse context could not be proven."}`;
      }
    }
    if (deleted) {
      history = null;
      notice =
        "Permanently deleted the inspected pages. This is irreversible; Undo is unavailable.";
    }
    const journal = decodeSpaceStructureJournal(
      { version: 1, environmentId: this.environmentId, pending: null, history },
      this.environmentId,
    );
    await this.#ports.store.write(this.environmentId, journal);
    this.#update({
      journal,
      trash: null,
      recoveryPreview: null,
      window: null,
      body: null,
      position: null,
      blockSelection: null,
      notice,
    });
    this.#accepted = null;
    this.#ports.changed();
    try {
      await this.#ports.refresh([
        ...new Set([
          ...result.changed.pages.map((p) => p.pageId),
          ...(deleted?.deletedPageIds ?? []),
        ]),
      ]);
    } finally {
      this.#unlock();
    }
  }
  reinspect(): Promise<void> {
    if (this.#work || this.#snapshot.busy || !this.#snapshot.journal.pending?.conflict)
      return Promise.reject(
        new Error("Only a definite conflict can be cleared for explicit reinspection"),
      );
    const work = (async () => {
      this.#ports.assertAccess(true);
      this.#update({ busy: true, error: null });
      const journal = { ...this.#snapshot.journal, pending: null, history: null };
      await this.#ports.store.write(this.environmentId, journal);
      this.#update({
        journal,
        window: null,
        position: null,
        recoveryPreview: null,
        notice: "Inspect a new operation and confirm its current guards.",
      });
    })()
      .catch((error: unknown) => {
        this.#update({ error });
        throw error;
      })
      .finally(() => {
        this.#update({ busy: false });
        if (this.#work === work) this.#work = null;
      });
    this.#work = work;
    return work;
  }
}
