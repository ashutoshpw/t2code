import * as Schema from "effect/Schema";
import { EnvironmentId } from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import type { SpaceDraftStore } from "./session.ts";
import { spaceDraftMaxBytes, spaceJsonBytes } from "./draft.ts";

export const isPageIcon = Schema.is(C.SpacePageIcon);
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
export const recoveryHistory = Schema.Struct({
  operation: Schema.Literals(["trashPage", "restorePage"]),
  scope: Schema.Literals(["created child", "page recovery"]),
  pageId: C.SpacePageId,
  pageIds: Schema.Array(C.SpacePageId),
  pages: Schema.Array(C.SpacePageSummary),
  guards: C.SpaceStructureGuards,
  observed: C.SpaceStructureGuards,
  direction: Schema.Literals(["undo", "redo"]),
});
const libraryRequestSchema = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("createSpace"), input: C.SpaceCreateInput }),
  Schema.Struct({ operation: Schema.Literal("renameSpace"), input: C.SpaceRenameInput }),
  Schema.Struct({ operation: Schema.Literal("setDefaultSpace"), input: C.SpaceSetDefaultInput }),
  Schema.Struct({ operation: Schema.Literal("createPage"), input: C.SpacePageCreateInput }),
  Schema.Struct({ operation: Schema.Literal("updatePage"), input: C.SpacePageUpdateInput }),
]);
export type SpaceLibraryRequest = typeof libraryRequestSchema.Type;
export type SpaceLibraryReceipt = Extract<
  C.SpaceMutationReceipt,
  { operation: SpaceLibraryRequest["operation"] }
>;
export const isLibraryRequest = (r: { operation: string }): r is SpaceLibraryRequest =>
  ["createSpace", "renameSpace", "setDefaultSpace", "createPage", "updatePage"].includes(
    r.operation,
  );
export const isLibraryReceipt = (r: C.SpaceMutationReceipt): r is SpaceLibraryReceipt =>
  isLibraryRequest(r);
export const libraryProof = Schema.Struct({
  version: Schema.Literals([1, 2]),
  space: Schema.optionalKey(C.SpaceSummary),
  previousDefault: Schema.optionalKey(C.SpaceSummary),
  page: Schema.optionalKey(C.SpacePageSummary),
  knownIds: Schema.optionalKey(Schema.Array(Schema.String)),
});
const pendingSchema = Schema.Struct({
  ...context,
  request: Schema.Union([
    libraryRequestSchema,
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
  library: Schema.optionalKey(libraryProof),
  recoveryPageIds: Schema.optionalKey(Schema.Array(C.SpacePageId)),
  recoveryBefore: Schema.optionalKey(Schema.Array(C.SpacePageSummary)),
  recoveryScope: Schema.optionalKey(Schema.Literals(["created child", "page recovery"])),
  knownBlockIds: Schema.optionalKey(Schema.Array(C.SpaceBlockId)),
  inverse: Schema.NullOr(C.SpacePageDestination),
  observed: C.SpaceStructureGuards,
  direction: Schema.Literals(["move", "undo", "redo"]),
  conflict: Schema.Boolean,
  rejection: Schema.optionalKey(
    Schema.Literals(["invalid_input", "invalid_recovery_state", "invalid_order"]),
  ),
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
export type Pending = typeof pendingSchema.Type;
export type Destination = C.SpacePageDestination;
export type MoveReceipt =
  | { operation: "movePage"; result: C.SpaceMovePageResult }
  | { operation: "moveBlocks"; result: C.SpaceMoveBlocksResult }
  | { operation: "createChildPage"; result: C.SpaceCreateChildPageResult }
  | { operation: "trashPage" | "restorePage"; result: C.SpacePageRecoveryResult }
  | { operation: "permanentlyDeletePage"; result: C.SpacePagePurgeResult };
export const sameLocation = (a: C.SpacePageLocation, b: C.SpacePageLocation) =>
  a.kind === b.kind &&
  a.spaceId === b.spaceId &&
  (a.kind === "root" ||
    (b.kind === "child" && a.ownerBlockId === b.ownerBlockId && a.parentPageId === b.parentPageId));
const recoveryRequest = (operation: Pending["request"]["operation"]) =>
  operation === "trashPage" || operation === "restorePage" || operation === "permanentlyDeletePage";
export const sameIds = <A extends string>(a: readonly A[], b: readonly A[]) =>
  a.length === b.length && new Set(a).size === a.length && a.every((id) => b.includes(id));
export function sameRecoveryContext(
  a: readonly C.SpacePageSummary[],
  b: readonly C.SpacePageSummary[],
) {
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
export const isValidationError = Schema.is(C.SpaceValidationError);
export const copy = <A>(value: A): A => JSON.parse(JSON.stringify(value)) as A;
export function freeze<A>(value: A): A {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function guards(value: C.SpaceStructureGuards) {
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
export function merge(
  a: C.SpaceStructureGuards,
  b: C.SpaceStructureGuards,
): C.SpaceStructureGuards {
  return {
    pages: [...new Map([...a.pages, ...b.pages].map((p) => [p.pageId, p])).values()],
    roots: [...new Map([...a.roots, ...b.roots].map((p) => [p.spaceId, p])).values()],
  };
}
export function covered(known: C.SpaceStructureGuards, proposed: C.SpaceStructureGuards) {
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
    const request = p.request;
    if (isLibraryRequest(request)) {
      validateLibraryPending(p, request, environmentId);
    } else {
      if (p.library) throw new Error("Unexpected library metadata");
      if (
        request.input.environmentId !== environmentId ||
        request.input.mutationId.length > 128 ||
        !covered(p.observed, request.input.guards)
      )
        throw new Error("Invalid retained placement");
      guards(request.input.guards);
      guards(p.observed);
      if (
        p.rejection &&
        (request.operation !== "permanentlyDeletePage" ||
          !p.conflict ||
          p.rejection === "invalid_order")
      )
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
            request.input.guards.pages.map((g) => g.pageId),
            p.observed.pages.map((g) => g.pageId),
          ) ||
          !p.observed.roots.every(
            (g) =>
              request.input.guards.roots.some((k) => k.spaceId === g.spaceId) ||
              g.spaceId === p.targetSpaceId,
          ) ||
          !request.input.guards.pages.some((g) => g.pageId === request.input.placement.pageId) ||
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
          !p.recoveryPageIds.every((id) => request.input.guards.pages.some((g) => g.pageId === id))
        )
          throw new Error("Invalid retained recovery closure");
        if (p.recoveryBefore) recoveryPages(p.recoveryBefore, request.input.guards);
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
function validateLibraryPending(p: Pending, r: SpaceLibraryRequest, environmentId: EnvironmentId) {
  const proof = p.library,
    i = r.input;
  if (
    !proof ||
    i.environmentId !== environmentId ||
    i.mutationId.length > 128 ||
    p.inverse ||
    p.direction !== "move" ||
    p.sourceLocation ||
    p.targetSpaceId ||
    (p.rejection &&
      (p.rejection !== "invalid_order" || r.operation !== "createPage" || !p.conflict)) ||
    p.recoveryPageIds ||
    p.recoveryBefore ||
    p.recoveryScope ||
    p.knownBlockIds ||
    (proof.knownIds &&
      (proof.knownIds.length > 50 || new Set(proof.knownIds).size !== proof.knownIds.length))
  )
    throw new Error("Invalid retained library intent");
  spaceJsonBytes(proof, 256 * 1024);
  let expected: C.SpaceStructureGuards = { pages: [], roots: [] };
  if (r.operation === "createSpace") {
    if (proof.space || proof.page || proof.previousDefault)
      throw new Error("Invalid create-space proof");
  } else if (r.operation === "updatePage") {
    const page = proof.page;
    if (
      !page ||
      page.id !== r.input.pageId ||
      page.revision !== r.input.baseRevision ||
      page.trash ||
      proof.space ||
      proof.previousDefault
    )
      throw new Error("Invalid rename-page proof");
    expected = { pages: [{ pageId: page.id, revision: page.revision }], roots: [] };
  } else {
    const space = proof.space;
    if (!space || space.id !== r.input.spaceId || proof.page)
      throw new Error("Invalid library space proof");
    if (r.operation === "createPage") {
      if (space.rootOrderRevision !== r.input.baseRootOrderRevision || proof.previousDefault)
        throw new Error("Invalid root creation proof");
      expected = {
        pages: [],
        roots: [{ spaceId: space.id, rootOrderRevision: space.rootOrderRevision }],
      };
    } else {
      if (space.revision !== r.input.baseRevision)
        throw new Error("Invalid library metadata revision");
      if (r.operation === "setDefaultSpace") {
        const previous = proof.previousDefault;
        if (
          !previous?.isDefault ||
          previous.id !== r.input.defaultSpaceId ||
          previous.revision !== r.input.baseDefaultRevision ||
          space.isDefault !== (space.id === previous.id)
        )
          throw new Error("Invalid retained default guard");
      } else if (proof.previousDefault) throw new Error("Unexpected default metadata");
    }
  }
  if (JSON.stringify(expected) !== JSON.stringify(p.observed))
    throw new Error("Invalid library affected-page boundary");
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
