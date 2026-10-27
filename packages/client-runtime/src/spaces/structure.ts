import * as Schema from "effect/Schema";
import { EnvironmentId } from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import type { SpaceDraftStore } from "./session.ts";
import { spaceDraftMaxBytes, spaceJsonBytes } from "./draft.ts";

const root = Schema.Struct({
  kind: Schema.Literal("root"),
  spaceId: C.SpaceId,
  beforePageId: Schema.NullOr(C.SpacePageId),
});
const placement = Schema.Struct({
  pageId: C.SpacePageId,
  destination: root,
  opposite: root,
  guards: C.SpaceStructureGuards,
  observed: C.SpaceStructureGuards,
});
const pendingSchema = Schema.Struct({
  request: Schema.Struct({ operation: Schema.Literal("movePage"), input: C.SpaceMovePageInput }),
  inverse: root,
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
type Root = typeof root.Type;
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
function guards(value: C.SpaceStructureGuards, spaceId: C.SpaceId) {
  if (
    value.pages.length < 1 ||
    value.pages.length > 8 ||
    value.roots.length !== 1 ||
    value.roots[0]?.spaceId !== spaceId ||
    new Set(value.pages.map((p) => p.pageId)).size !== value.pages.length ||
    value.pages.some((p) => !Number.isSafeInteger(p.revision)) ||
    !Number.isSafeInteger(value.roots[0].rootOrderRevision)
  )
    throw new Error("Root placement exceeds the eight-page guard boundary");
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
  const p = journal.pending;
  if (p) {
    const input = p.request.input;
    if (
      input.environmentId !== environmentId ||
      input.destination.kind !== "root" ||
      input.destination.spaceId !== p.inverse.spaceId ||
      input.destination.beforePageId === input.pageId ||
      p.inverse.beforePageId === input.pageId ||
      input.mutationId.length > 128 ||
      !p.observed.pages.some((row) => row.pageId === input.pageId) ||
      !covered(p.observed, input.guards)
    )
      throw new Error("Invalid retained root placement");
    guards(input.guards, p.inverse.spaceId);
    guards(p.observed, p.inverse.spaceId);
    spaceJsonBytes(p.request, 1024 * 1024);
  }
  const h = journal.history;
  if (h) {
    if (
      h.destination.spaceId !== h.opposite.spaceId ||
      h.destination.beforePageId === h.pageId ||
      h.opposite.beforePageId === h.pageId ||
      !h.guards.pages.some((p) => p.pageId === h.pageId) ||
      !covered(h.observed, h.guards)
    )
      throw new Error("Invalid retained placement history");
    guards(h.guards, h.destination.spaceId);
    guards(h.observed, h.destination.spaceId);
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
}
interface Snapshot {
  readonly hydrated: boolean;
  readonly busy: boolean;
  readonly journal: SpaceStructureJournal;
  readonly window: C.SpacePageListResult | null;
  readonly position: Position | null;
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
  #edge: Omit<Position, "beforePageId"> | null = null;
  constructor(environmentId: EnvironmentId, ports: SpaceRootReorderPorts) {
    this.environmentId = environmentId;
    this.#ports = ports;
    this.#snapshot = {
      hydrated: false,
      busy: false,
      window: null,
      position: null,
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
  async browse(spaceId: C.SpaceId, pageId: C.SpacePageId, next = false): Promise<void> {
    await this.hydrate();
    this.#ports.assertAccess(false);
    if (this.#work || this.#snapshot.busy || this.#snapshot.journal.pending)
      throw new Error("Resolve the retained placement first");
    const old = this.#snapshot.window;
    const cursor = next && old?.space.id === spaceId ? old.nextCursor : null;
    if (next && !cursor) throw new Error("No next root window");
    const request = ++this.#read;
    this.#update({ busy: true, error: null });
    try {
      const window = await this.#ports.list({
        environmentId: this.environmentId,
        spaceId,
        limit: Math.min(50, this.#ports.maxRows()),
        ...(cursor ? { cursor } : {}),
      });
      if (request !== this.#read) return;
      let position = this.#snapshot.position;
      if (position?.rootRevision !== window.space.rootOrderRevision || position.pageId !== pageId)
        position = null;
      if (
        next &&
        this.#edge?.pageId === pageId &&
        this.#edge.rootRevision === window.space.rootOrderRevision &&
        (window.items[0] || window.nextCursor === null)
      ) {
        position = { ...this.#edge, beforePageId: window.items[0]?.id ?? null };
        this.#edge = null;
      }
      if (!next || this.#edge?.rootRevision !== window.space.rootOrderRevision) this.#edge = null;
      const index = window.items.findIndex((p) => p.id === pageId);
      const page = window.items[index];
      const successor = window.items[index + 1];
      if (page && page.location?.kind === "root" && (successor || window.nextCursor === null))
        position = {
          pageId,
          revision: page.revision,
          rootRevision: window.space.rootOrderRevision,
          beforePageId: successor?.id ?? null,
        };
      if (page && !successor && window.nextCursor !== null)
        this.#edge = {
          pageId,
          revision: page.revision,
          rootRevision: window.space.rootOrderRevision,
        };
      this.#update({ window: copy(window), position });
    } catch (error) {
      if (request === this.#read) this.#update({ error });
      throw error;
    } finally {
      if (request === this.#read) this.#update({ busy: false });
    }
  }
  move(pageId: C.SpacePageId, spaceId: C.SpaceId, beforePageId: C.SpacePageId | null) {
    return this.#exclusive(async () => {
      const { window, position } = this.#snapshot;
      if (
        !window ||
        window.space.id !== spaceId ||
        !position ||
        position.pageId !== pageId ||
        (beforePageId === null
          ? window.nextCursor !== null
          : !window.items.some((p) => p.id === beforePageId)) ||
        beforePageId === pageId
      )
        throw new Error("Load the original position and a proven destination window first");
      const destination: Root = { kind: "root", spaceId, beforePageId };
      const inverse: Root = { kind: "root", spaceId, beforePageId: position.beforePageId };
      const forward = await this.#inspect(pageId, destination);
      const back = await this.#inspect(pageId, inverse);
      if (
        !covered(forward.guards, {
          pages: back.guards.pages.filter((p) =>
            forward.guards.pages.some((f) => f.pageId === p.pageId),
          ),
          roots: back.guards.roots,
        }) ||
        forward.guards.roots[0]?.rootOrderRevision !== position.rootRevision ||
        forward.guards.pages.find((p) => p.pageId === pageId)?.revision !== position.revision
      )
        throw new Error("Root placement changed; load its position again");
      const observed = merge(forward.guards, back.guards);
      guards(observed, spaceId);
      await this.#prepare(pageId, destination, inverse, forward.guards, observed, "move");
    });
  }
  compensate(direction: "undo" | "redo") {
    return this.#exclusive(async () => {
      const h = this.#snapshot.journal.history;
      if (!h || h.direction !== direction)
        throw new Error("No guarded placement is retained for this direction");
      await this.#prepare(h.pageId, h.destination, h.opposite, h.guards, h.observed, direction);
    });
  }
  async #inspect(pageId: C.SpacePageId, destination: Root) {
    const result = await this.#ports.inspect({
      environmentId: this.environmentId,
      target: { kind: "page", pageId },
      destination,
    });
    guards(result.guards, destination.spaceId);
    const source = result.pages.find((p) => p.id === pageId);
    if (source?.location?.kind !== "root" || source.spaceId !== destination.spaceId)
      throw new Error("Only same-space root placement is supported");
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
    destination: Root,
    inverse: Root,
    expected: C.SpaceStructureGuards,
    observed: C.SpaceStructureGuards,
    direction: Pending["direction"],
  ) {
    const pages = observed.pages.map((p) => p.pageId);
    this.#release = this.#ports.reserve(pages, false);
    try {
      await this.#ports.checkDrafts(pages);
      const admission = await this.#ports.getPage(pageId);
      if (
        admission.page.location?.kind !== "root" ||
        admission.page.spaceId !== destination.spaceId
      )
        throw new Error("The page is no longer a root in this space");
      this.#ports.assertAccess(true);
      const pending: Pending = {
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
    if (
      result.page.id !== p.request.input.pageId ||
      result.page.location?.kind !== "root" ||
      result.page.spaceId !== p.inverse.spaceId
    )
      throw new Error("Mismatched structural receipt page");
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
          opposite: p.request.input.destination as Root,
          guards: inverse.guards,
          observed,
          direction: p.direction === "undo" ? "redo" : "undo",
        };
        notice = "Placement accepted. One guarded placement undo/redo is retained.";
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
    this.#update({ journal, window: null, position: null, notice });
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
