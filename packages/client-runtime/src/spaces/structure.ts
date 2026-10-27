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
  ...context,
  pageId: C.SpacePageId,
  destination: C.SpacePageDestination,
  opposite: C.SpacePageDestination,
  guards: C.SpaceStructureGuards,
  observed: C.SpaceStructureGuards,
});
const pendingSchema = Schema.Struct({
  ...context,
  request: Schema.Struct({ operation: Schema.Literal("movePage"), input: C.SpaceMovePageInput }),
  inverse: C.SpacePageDestination,
  observed: C.SpaceStructureGuards,
  direction: Schema.Literals(["move", "undo", "redo"]),
  conflict: Schema.Boolean,
});
const journalSchema = Schema.Struct({
  version: Schema.Literal(1),
  environmentId: EnvironmentId,
  pending: Schema.NullOr(pendingSchema),
  history: Schema.NullOr(
    Schema.Struct({ ...placement.fields, direction: Schema.Literals(["undo", "redo"]) }),
  ),
});
export type SpaceStructureJournal = typeof journalSchema.Type;
type Pending = typeof pendingSchema.Type;
type Destination = C.SpacePageDestination;
const sameLocation = (a: C.SpacePageLocation, b: C.SpacePageLocation) =>
  a.kind === b.kind &&
  a.spaceId === b.spaceId &&
  (a.kind === "root" ||
    (b.kind === "child" && a.ownerBlockId === b.ownerBlockId && a.parentPageId === b.parentPageId));
export const spaceStructureMaxBytes = 2 * 1024 * 1024;
const decode = Schema.decodeUnknownSync(journalSchema, { onExcessProperty: "error" });
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
  const p = journal.pending;
  if (p) {
    const input = p.request.input;
    if (
      input.environmentId !== environmentId ||
      input.mutationId.length > 128 ||
      !p.observed.pages.some((row) => row.pageId === input.pageId) ||
      !covered(p.observed, input.guards) ||
      (input.destination.kind === "child" && (!p.targetSpaceId || !p.sourceLocation))
    )
      throw new Error("Invalid retained page placement");
    guards(input.guards);
    guards(p.observed);
    destination(input.destination, input.pageId, input.guards);
    destination(p.inverse, input.pageId, p.observed);
    source(p.sourceLocation, p.inverse);
    if (
      p.targetSpaceId &&
      input.destination.kind === "root" &&
      p.targetSpaceId !== input.destination.spaceId
    )
      throw new Error("Invalid retained destination space");
    spaceJsonBytes(p.request, 1024 * 1024);
  }
  const h = journal.history;
  if (h) {
    if (
      !h.guards.pages.some((p) => p.pageId === h.pageId) ||
      !covered(h.observed, h.guards) ||
      (h.destination.kind === "child" && (!h.targetSpaceId || !h.sourceLocation))
    )
      throw new Error("Invalid retained placement history");
    guards(h.guards);
    guards(h.observed);
    destination(h.destination, h.pageId, h.guards);
    destination(h.opposite, h.pageId, h.observed);
    source(h.sourceLocation, h.opposite);
    if (
      h.targetSpaceId &&
      h.destination.kind === "root" &&
      h.targetSpaceId !== h.destination.spaceId
    )
      throw new Error("Invalid retained inverse space");
    spaceJsonBytes(h, 256 * 1024);
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
interface Snapshot {
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
  #accepted: C.SpaceMovePageResult | null = null;
  #read = 0;
  #edge: Position | null = null;
  constructor(environmentId: EnvironmentId, ports: SpaceRootReorderPorts) {
    this.environmentId = environmentId;
    this.#ports = ports;
    this.#snapshot = {
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
  compensate(direction: "undo" | "redo") {
    return this.#exclusive(async () => {
      const h = this.#snapshot.journal.history;
      if (!h || h.direction !== direction)
        throw new Error("No guarded placement is retained for this direction");
      let current: C.SpaceInspectStructureResult;
      try {
        current = await this.#inspect(h.pageId, h.destination);
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
  #exclusive(use: () => Promise<void>): Promise<void> {
    if (this.#work) return Promise.reject(new Error("Another placement operation is in progress"));
    const work = (async () => {
      await this.hydrate();
      this.#ports.assertAccess(true);
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
    const pages = observed.pages.map((p) => p.pageId);
    this.#release = this.#ports.reserve(pages, false);
    try {
      await this.#ports.checkDrafts(pages);
      const admission = await this.#ports.getPage(pageId);
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
      this.#ports.assertAccess(true);
      const pending: Pending = {
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
    const result = await this.#ports.move(copy(pending.request.input));
    await this.#ack(result);
  }
  recover(): Promise<void> {
    if (this.#work) return Promise.reject(new Error("Another placement operation is in progress"));
    const work = (async () => {
      await this.hydrate();
      this.#ports.assertAccess(false);
      if (this.#snapshot.busy) throw new Error("Wait for the current root window");
      const p = this.#snapshot.journal.pending;
      if (!p || p.conflict) throw new Error("No uncertain placement to recover");
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
        if (receipt.receipt.operation !== "movePage")
          throw new Error("Mismatched structural receipt operation");
        await this.#ack(receipt.receipt.result);
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
  async #ack(result: C.SpaceMovePageResult) {
    const p = this.#snapshot.journal.pending!;
    if (
      result.mutationId !== p.request.input.mutationId ||
      result.receiptEpoch !== p.request.input.receiptEpoch
    )
      throw new Error("Mismatched structural receipt identity");
    if (result.status === "conflict") {
      this.#accepted = result;
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
    const destination = p.request.input.destination;
    const targetSpaceId =
      p.targetSpaceId ?? (destination.kind === "root" ? destination.spaceId : null);
    const location = result.page.location;
    if (
      result.page.id !== p.request.input.pageId ||
      !location ||
      result.page.spaceId !== targetSpaceId ||
      (destination.kind === "root"
        ? location.kind !== "root" || result.ownerBlockId !== null
        : location.kind !== "child" ||
          location.parentPageId !== destination.placement.pageId ||
          !result.ownerBlockId ||
          location.ownerBlockId !== result.ownerBlockId ||
          (p.sourceLocation?.kind === "child" &&
            p.sourceLocation.ownerBlockId !== result.ownerBlockId))
    )
      throw new Error("Mismatched structural receipt page or owner");
    for (const row of result.changed.pages)
      if (!p.observed.pages.some((k) => k.pageId === row.pageId && row.revision === k.revision + 1))
        throw new Error("Unobserved structural page acknowledgement");
    for (const row of result.changed.roots)
      if (
        !p.observed.roots.some(
          (k) => k.spaceId === row.spaceId && row.rootOrderRevision === k.rootOrderRevision + 1,
        )
      )
        throw new Error("Unobserved structural root acknowledgement");
    const observed = merge(p.observed, result.changed);
    if (
      observed.pages.find((row) => row.pageId === result.page.id)?.revision !==
        result.page.revision ||
      new Set(result.changed.pages.map((row) => row.pageId)).size !== result.changed.pages.length ||
      new Set(result.changed.roots.map((row) => row.spaceId)).size !== result.changed.roots.length
    )
      throw new Error("Inconsistent structural acknowledgement guards");
    this.#accepted = result;
    let history: SpaceStructureJournal["history"] = null;
    let notice = "Placement accepted. No compensating placement could be retained.";
    if (result.changed.pages.length || result.changed.roots.length) {
      try {
        const inverse = await this.#inspect(p.request.input.pageId, p.inverse);
        if (!covered(observed, inverse.guards))
          throw new Error("The inverse placement changed after acknowledgement");
        history = {
          pageId: p.request.input.pageId,
          destination: p.inverse,
          opposite: p.request.input.destination,
          targetSpaceId:
            p.sourceLocation?.spaceId ??
            (p.inverse.kind === "root" ? p.inverse.spaceId : result.page.spaceId),
          sourceLocation: location,
          guards: inverse.guards,
          observed,
          direction: p.direction === "undo" ? "redo" : "undo",
        };
        notice =
          "Placement accepted. One guarded placement undo/redo is retained." +
          (p.sourceLocation && p.sourceLocation.kind !== location.kind
            ? " Root/child undo restores page placement, not retired owner-marker IDs or their links."
            : "");
      } catch (error) {
        notice = error instanceof Error ? error.message : notice;
      }
    } else {
      if (p.direction === "move") history = this.#snapshot.journal.history;
      notice = "The page was already in that position.";
    }
    const journal = decodeSpaceStructureJournal(
      { version: 1, environmentId: this.environmentId, pending: null, history },
      this.environmentId,
    );
    await this.#ports.store.write(this.environmentId, journal);
    this.#update({ journal, window: null, body: null, position: null, notice });
    this.#accepted = null;
    this.#ports.changed();
    try {
      await this.#ports.refresh(result.changed.pages.map((p) => p.pageId));
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
        notice: "Load position and choose a new placement.",
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
