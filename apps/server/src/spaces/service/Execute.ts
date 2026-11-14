// @effect-diagnostics nodeBuiltinImport:off -- stable IDs are allocated by the platform cryptographic generator.
import * as NodeCrypto from "node:crypto";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import { byteLength } from "../CorePolicy.ts";
import * as Receipts from "../Receipts.ts";
import * as RevisionStore from "../RevisionStore.ts";
import * as PageChanges from "../PageChanges.ts";
import * as PageUpdate from "../PageUpdate.ts";
import * as Settle from "../databases/computed/Settle.ts";
import * as DatabaseStore from "../databases/DatabaseStore.ts";
import * as DatabaseHooks from "../databases/Hooks.ts";
import * as Liveness from "../databases/Liveness.ts";
import * as Touched from "../databases/Touched.ts";
import { isoNow } from "../databases/Types.ts";
import * as DatabaseMutations from "../databases/Mutations.ts";
import * as CommentWrites from "../comments/Writes.ts";
import { applyBatch } from "./BlockBatch.ts";
import * as PageStore from "../PageStore.ts";
import * as PageStructure from "../PageStructure.ts";
import * as SyncedBlocks from "../SyncedBlocks.ts";
import * as PageRecovery from "../PageRecovery.ts";
import * as SpacesSql from "../SpacesSql.ts";
import * as SearchStore from "../SearchStore.ts";
import {
  type SpaceRow,
  type PageRow,
  spaceSummary,
  pageSummary,
  decodeReceipt,
  getSpace,
  getPageRow,
  defaultSpace,
} from "./Helpers.ts";

/**
 * Applies a planned trash, restore or permanent delete and the database bookkeeping after it.
 * The user's mutation and the dead-database sweep both end here, so they cannot drift apart.
 */
export const finishRecovery = Effect.fn("SpacesService.finishRecovery")(function* (
  plan: PageStructure.Plan,
  operation: "trashPage" | "restorePage" | "permanentlyDeletePage",
  mutationId: string,
  nowMs: number,
) {
  const recoveryRows = DatabaseHooks.recoveryRows(plan);
  const result =
    operation === "permanentlyDeletePage"
      ? yield* PageRecovery.purge(plan, mutationId, nowMs)
      : yield* PageStructure.apply(plan, mutationId, nowMs);
  const affectedDataSourceIds = yield* DatabaseHooks.afterRecovery(operation, recoveryRows, nowMs);
  return { result, affectedDataSourceIds };
});

export const execute = Effect.fn("SpacesService.execute")(function* (
  request: C.SpaceMutationRequest,
  meta: Receipts.Metadata,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const input = request.input;
  const now = DateTime.formatIso(DateTime.makeUnsafe(meta.observed_time_ms));
  const ack = { mutationId: input.mutationId, receiptEpoch: input.receiptEpoch };
  const conflict = Effect.fnUntraced(function* (
    spaces: readonly SpaceRow[],
    pages: readonly PageRow[] = [],
  ) {
    const def = yield* defaultSpace();
    return {
      status: "conflict" as const,
      ...ack,
      current: {
        catalogRevision: meta.catalog_revision,
        defaultSpaceId: def.space_id,
        spaces: spaces.map(spaceSummary),
        pages: pages.map((row) => pageSummary(row)),
      },
    };
  });
  const changed = Effect.fnUntraced(function* () {
    yield* sql`UPDATE spaces_core SET catalog_revision = catalog_revision + 1 WHERE singleton = 1`;
  });
  switch (request.operation) {
    case "trashPage":
    case "restorePage":
    case "permanentlyDeletePage":
    case "createChildPage":
    case "moveBlocks":
    case "movePage": {
      const structural =
        request.operation === "trashPage" ||
        request.operation === "restorePage" ||
        request.operation === "permanentlyDeletePage"
          ? {
              environmentId: request.input.environmentId,
              target: { kind: "page" as const, pageId: request.input.pageId },
              recovery:
                request.operation === "trashPage"
                  ? ("trash" as const)
                  : request.operation === "restorePage"
                    ? ("restore" as const)
                    : ("permanentlyDelete" as const),
            }
          : request.operation === "moveBlocks"
            ? {
                environmentId: request.input.environmentId,
                target: {
                  kind: "blocks" as const,
                  pageId: request.input.sourcePageId,
                  blockIds: request.input.blockIds,
                },
                destination: { kind: "child" as const, placement: request.input.destination },
              }
            : request.operation === "createChildPage"
              ? {
                  environmentId: request.input.environmentId,
                  target: {
                    kind: "blocks" as const,
                    pageId: request.input.placement.pageId,
                    blockIds: [],
                  },
                  destination: { kind: "child" as const, placement: request.input.placement },
                }
              : {
                  environmentId: request.input.environmentId,
                  target: { kind: "page" as const, pageId: request.input.pageId },
                  destination: request.input.destination,
                };
      const plan = yield* PageStructure.plan(structural, byteLength(request));
      if (request.operation === "movePage" || request.operation === "moveBlocks")
        yield* DatabaseHooks.guardMove(plan);
      if (!(yield* PageStructure.guardsMatch(plan, request.input.guards))) {
        const def = yield* defaultSpace();
        return decodeReceipt({
          operation: request.operation,
          result: {
            status: "conflict",
            ...ack,
            current: {
              catalogRevision: meta.catalog_revision,
              defaultSpaceId: def.space_id,
              ...plan.guards,
            },
          },
        });
      }
      const { result, affectedDataSourceIds } =
        request.operation === "movePage" ||
        request.operation === "moveBlocks" ||
        request.operation === "createChildPage"
          ? {
              result: yield* PageStructure.apply(
                plan,
                request.input.mutationId,
                meta.observed_time_ms,
                request.operation === "createChildPage" ? request.input.title : undefined,
              ),
              affectedDataSourceIds: [],
            }
          : yield* finishRecovery(
              plan,
              request.operation,
              request.input.mutationId,
              meta.observed_time_ms,
            );
      return decodeReceipt({
        operation: request.operation,
        result: {
          status: "saved",
          ...ack,
          ...result,
          ...(affectedDataSourceIds.length === 0 ? {} : { affectedDataSourceIds }),
        },
      });
    }
    case "createSpace": {
      const input = request.input;
      const id = C.SpaceId.make(NodeCrypto.randomUUID());
      yield* sql`INSERT INTO spaces_ids (id, kind) VALUES (${id}, 'space')`;
      yield* sql`INSERT INTO spaces (space_id, title, is_default, created_at, updated_at) VALUES (${id}, ${input.title}, 0, ${now}, ${now})`;
      yield* PageChanges.recordSpace(id);
      yield* changed();
      return decodeReceipt({
        operation: request.operation,
        result: { status: "saved", ...ack, space: spaceSummary(yield* getSpace(id)) },
      });
    }
    case "renameSpace": {
      const input = request.input;
      const space = yield* getSpace(input.spaceId);
      if (space.revision !== input.baseRevision)
        return decodeReceipt({ operation: request.operation, result: yield* conflict([space]) });
      if (space.title !== input.title) {
        yield* sql`UPDATE spaces SET title = ${input.title}, revision = revision + 1, updated_at = ${now} WHERE space_id = ${input.spaceId}`;
        yield* PageChanges.recordSpace(input.spaceId);
        yield* changed();
      }
      return decodeReceipt({
        operation: request.operation,
        result: { status: "saved", ...ack, space: spaceSummary(yield* getSpace(input.spaceId)) },
      });
    }
    case "setDefaultSpace": {
      const input = request.input;
      const space = yield* getSpace(input.spaceId);
      const previous = yield* getSpace(input.defaultSpaceId);
      const def = yield* defaultSpace();
      if (
        space.revision !== input.baseRevision ||
        previous.revision !== input.baseDefaultRevision ||
        previous.space_id !== def.space_id
      ) {
        return decodeReceipt({
          operation: request.operation,
          result: yield* conflict(space.space_id === def.space_id ? [space] : [space, def]),
        });
      }
      if (space.space_id !== previous.space_id) {
        yield* sql`UPDATE spaces SET is_default = 0, revision = revision + 1, updated_at = ${now} WHERE space_id = ${previous.space_id}`;
        yield* sql`UPDATE spaces SET is_default = 1, revision = revision + 1, updated_at = ${now} WHERE space_id = ${space.space_id}`;
        yield* PageChanges.recordSpace(previous.space_id);
        yield* PageChanges.recordSpace(space.space_id);
        yield* changed();
      }
      return decodeReceipt({
        operation: request.operation,
        result: {
          status: "saved",
          ...ack,
          space: spaceSummary(yield* getSpace(space.space_id)),
          previousDefaultSpace: spaceSummary(yield* getSpace(previous.space_id)),
        },
      });
    }
    case "createPage": {
      const input = request.input;
      const space = yield* getSpace(input.spaceId);
      if (space.root_order_revision !== input.baseRootOrderRevision)
        return decodeReceipt({ operation: request.operation, result: yield* conflict([space]) });
      const [last] = yield* sql<{
        readonly root_order: string;
      }>`SELECT root_order FROM spaces_pages WHERE space_id = ${input.spaceId} AND root_order IS NOT NULL ORDER BY root_order DESC, page_id DESC LIMIT 1`;
      const rank = last ? BigInt(`0x${last.root_order}`) + 1n : 1n;
      if (rank >= 1n << 128n) return yield* new C.SpaceValidationError({ reason: "invalid_order" });
      const id = C.SpacePageId.make(NodeCrypto.randomUUID());
      yield* sql`INSERT INTO spaces_ids (id, kind) VALUES (${id}, 'page')`;
      yield* sql`INSERT INTO spaces_pages (page_id, space_id, title, root_order, created_at, updated_at)
        VALUES (${id}, ${input.spaceId}, ${input.title}, ${rank.toString(16).padStart(32, "0")}, ${now}, ${now})`;
      yield* SearchStore.writeTitle(id, input.title);
      yield* RevisionStore.capture(
        {
          pageId: id,
          toRevision: 0,
          mutationId: input.mutationId,
          pageBefore: null,
          blocksBefore: [],
        },
        meta.observed_time_ms,
      );
      yield* sql`UPDATE spaces SET root_order_revision = root_order_revision + 1, updated_at = ${now} WHERE space_id = ${input.spaceId}`;
      yield* PageChanges.recordPage(id, input.spaceId, { tree: true });
      yield* changed();
      return decodeReceipt({
        operation: request.operation,
        result: {
          status: "saved",
          ...ack,
          page: pageSummary(yield* getPageRow(id)),
          space: spaceSummary(yield* getSpace(input.spaceId)),
        },
      });
    }
    case "updatePage": {
      const input = request.input;
      const page = yield* getPageRow(input.pageId);
      yield* PageStore.assertActive(page);
      if (page.root_order === null) yield* Liveness.assertPageLive(page.page_id);
      // Title and icon are last-writer-wins: only a base from the future is a conflict.
      if (input.baseRevision > page.revision)
        return decodeReceipt({
          operation: request.operation,
          result: yield* conflict([yield* getSpace(page.space_id)], [page]),
        });
      const icon = input.icon === undefined ? (page.icon ?? null) : input.icon;
      yield* PageUpdate.apply(
        page,
        { title: input.title, icon },
        input.mutationId,
        meta.observed_time_ms,
      );
      const affectedDataSourceIds: C.SpaceDataSourceId[] = [];
      if (
        page.data_source_id !== null &&
        page.title === input.title &&
        icon !== (page.icon ?? null)
      ) {
        // The row's icon is part of every row read; no computed value reads it.
        yield* DatabaseStore.bumpData(page.data_source_id, isoNow(meta.observed_time_ms));
        affectedDataSourceIds.push(C.SpaceDataSourceId.make(page.data_source_id));
      } else if (page.data_source_id !== null && page.title !== input.title) {
        const touched = Touched.touched();
        Touched.recordCell(touched, page.page_id, page.data_source_id, "title");
        yield* Settle.settleAndDrain(touched);
        for (const id of touched.sources)
          yield* DatabaseStore.bumpData(id, isoNow(meta.observed_time_ms));
        for (const id of Touched.affected(touched, page.data_source_id))
          affectedDataSourceIds.push(C.SpaceDataSourceId.make(id));
      }
      return decodeReceipt({
        operation: request.operation,
        result: {
          status: "saved",
          ...ack,
          page: pageSummary(yield* getPageRow(input.pageId)),
          ...(affectedDataSourceIds.length === 0 ? {} : { affectedDataSourceIds }),
        },
      });
    }
    case "applyBlockBatch": {
      const input = request.input;
      const page = yield* getPageRow(input.pageId);
      yield* PageStore.assertActive(page);
      if (page.root_order === null) yield* Liveness.assertPageLive(page.page_id);
      // Title and icon changes since the base do not touch blocks, so only a newer body or a base from the future conflicts.
      if (input.baseRevision < page.body_revision || input.baseRevision > page.revision)
        return decodeReceipt({
          operation: request.operation,
          result: {
            ...(yield* conflict([yield* getSpace(page.space_id)], [page])),
            generation: input.generation,
            revision: page.revision,
          },
        });
      const result = yield* applyBatch({
        page,
        mutations: input.mutations,
        mutationId: input.mutationId,
        nowMs: meta.observed_time_ms,
        requestBytes: byteLength(request),
        ...(input.subtreeRootId === undefined ? {} : { scope: { rootId: input.subtreeRootId } }),
      });
      return decodeReceipt({
        operation: request.operation,
        result: {
          status: "saved",
          ...ack,
          generation: input.generation,
          revision: result.revision,
        },
      });
    }
    case "unsyncBlocks": {
      const pages = yield* SyncedBlocks.unsync(
        request.input,
        request.input.mutationId,
        meta.observed_time_ms,
      );
      return decodeReceipt({
        operation: request.operation,
        result: { status: "saved", ...ack, pages },
      });
    }
    case "createDatabase":
    case "updateDatabase":
    case "createDataSource":
    case "updateDataSource":
    case "deleteDataSource":
    case "updateSchema":
    case "createView":
    case "updateView":
    case "deleteView":
    case "createRows":
    case "updateRows":
    case "moveRows":
      return yield* DatabaseMutations.execute(request, meta);
    case "createCommentThread":
    case "replyComment":
    case "agentReplyComment":
    case "editComment":
    case "deleteComment":
    case "resolveCommentThread":
    case "reopenCommentThread":
      return yield* CommentWrites.execute(request, meta);
  }
});
