// @effect-diagnostics nodeBuiltinImport:off -- stable IDs are allocated by the platform cryptographic generator.
import * as NodeCrypto from "node:crypto";
import { SpaceContextCaptureInput } from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as BlockStore from "../BlockStore.ts";
import {
  byteLength,
  canonical,
  ensureLimit,
  limits,
  searchLimits,
  ensureSearchLimit,
} from "../CorePolicy.ts";
import * as Receipts from "../Receipts.ts";
import * as Liveness from "../databases/Liveness.ts";
import * as PageStore from "../PageStore.ts";
import * as PageStructure from "../PageStructure.ts";
import * as PageRecovery from "../PageRecovery.ts";
import * as ReferenceStore from "../ReferenceStore.ts";
import * as ContextSnapshot from "../ContextSnapshot.ts";
import * as SearchStore from "../SearchStore.ts";
import {
  spaceSummary,
  pageSummary,
  strict,
  decodeSearch,
  decodeGet,
  decodeReference,
  decodeInspect,
  decodeBlocks,
  isServiceError,
  isSearchUnavailable,
  validateRaw,
  cursorFor,
  cursorFrom,
  checkIds,
  needsWrite,
  getSpace,
  getPageRow,
} from "./Helpers.ts";
import type { Runtime } from "./Runtime.ts";

export const make = (rt: Runtime) => {
  const { admit, checkEnvironment, read, readThenWrite, readWithAdmission } = rt;
  const search = Effect.fn("SpacesService.search")(function* (raw: unknown) {
    const environmentId = yield* admit();
    const input = yield* validateRaw(raw).pipe(
      Effect.flatMap(decodeSearch),
      Effect.mapError((error) =>
        isServiceError(error) ? error : new C.SpaceValidationError({ reason: "invalid_input" }),
      ),
    );
    yield* checkEnvironment(environmentId, input.environmentId);
    const searchWith = (writable: boolean) => (meta: Receipts.Metadata) =>
      Effect.gen(function* () {
        yield* checkIds(input);
        const query = yield* SearchStore.literalQuery(input.query);
        const limit = input.limit ?? searchLimits.maxRows;
        yield* ensureSearchLimit("maxRows", limit);
        const filter = NodeCrypto.createHash("sha256")
          .update(canonical({ query: input.query, spaceId: input.spaceId ?? null }))
          .digest("hex");
        const cursor = yield* cursorFrom(
          input.cursor,
          environmentId,
          "search",
          filter,
          meta.catalog_revision,
        );
        const after = cursor === undefined ? 0 : Number(cursor.id);
        if (
          !Number.isSafeInteger(after) ||
          after < 0 ||
          (cursor && (String(after) !== cursor.id || cursor.key !== "doc"))
        )
          return yield* new C.SpaceValidationError({ reason: "invalid_cursor" });
        const status = writable ? yield* SearchStore.advance() : yield* SearchStore.phase();
        if (status === "building" && !writable) return needsWrite;
        if (status !== "ready") return new C.SpaceSearchUnavailableError({ reason: status });
        const rows = yield* SearchStore.candidates(query, after);
        const items: C.SpaceSearchResult["items"][number][] = [];
        let bytes = byteLength(rows.map((row) => ({ ...row })));
        yield* ensureSearchLimit("maxCandidateBytes", bytes);
        let consumed = 0;
        let last = after;
        for (const row of rows.slice(0, searchLimits.maxCandidates)) {
          const size = 8 + row.text_json_bytes;
          if (bytes + size > searchLimits.maxCandidateBytes) {
            if (consumed === 0) yield* ensureSearchLimit("maxCandidateBytes", bytes + size);
            break;
          }
          const visible =
            row.page_id !== null &&
            row.trash_batch_id === null &&
            row.row_template !== 1 &&
            (input.spaceId === undefined || row.space_id === input.spaceId) &&
            (row.root_order !== null || (yield* Liveness.pageLive(row.page_id)));
          const item = visible
            ? {
                page: PageStore.summary(row),
                ...(row.block_id === null ? {} : { blockId: row.block_id }),
                snippet: yield* SearchStore.snippet(query, row.doc_id),
              }
            : undefined;
          if (item) {
            const proposed: C.SpaceSearchResult = {
              catalogRevision: meta.catalog_revision,
              items: [...items, item],
              nextCursor: yield* cursorFor(
                environmentId,
                "search",
                filter,
                meta.catalog_revision,
                "doc",
                String(row.doc_id),
              ),
            };
            const responseBytes = byteLength(proposed);
            if (responseBytes > searchLimits.maxResponseBytes) {
              if (consumed === 0) yield* ensureSearchLimit("maxResponseBytes", responseBytes);
              break;
            }
            items.push(item);
          }
          bytes += size;
          consumed++;
          last = row.doc_id;
          if (items.length === limit) break;
        }
        return {
          catalogRevision: meta.catalog_revision,
          items,
          nextCursor:
            consumed < rows.length || rows.length === searchLimits.maxCandidates
              ? yield* cursorFor(
                  environmentId,
                  "search",
                  filter,
                  meta.catalog_revision,
                  "doc",
                  String(last),
                )
              : null,
        } satisfies C.SpaceSearchResult;
      });
    // The index is built lazily by writes; once ready, searching is a pure read.
    const result = yield* readThenWrite(
      environmentId,
      (meta) =>
        Effect.map(searchWith(false)(meta), (found) =>
          found === needsWrite ? needsWrite : { value: found },
        ),
      (meta) =>
        Effect.map(searchWith(true)(meta), (found) =>
          found === needsWrite ? new C.SpaceSearchUnavailableError({ reason: "storage" }) : found,
        ),
    );
    if (isSearchUnavailable(result)) return yield* result;
    return result;
  });
  const getPage = Effect.fn("SpacesService.getPage")(function* (raw: unknown) {
    const environmentId = yield* admit();
    const input = yield* validateRaw(raw).pipe(
      Effect.flatMap(decodeGet),
      Effect.mapError((e) =>
        isServiceError(e) ? e : new C.SpaceValidationError({ reason: "invalid_input" }),
      ),
    );
    yield* checkEnvironment(environmentId, input.environmentId);
    return yield* readWithAdmission(environmentId, (meta, admission) =>
      Effect.gen(function* () {
        yield* checkIds(input);
        const page = yield* getPageRow(input.pageId);
        yield* PageStore.assertActive(page);
        yield* Liveness.assertPageLive(page.page_id);
        const space = yield* getSpace(page.space_id);
        const result = {
          page: pageSummary(page),
          space: spaceSummary(space),
          mutationAdmission: admission,
        };
        yield* ensureLimit("maxListResponseBytes", byteLength(result));
        return result;
      }),
    );
  });
  const readBlocks = Effect.fn("SpacesService.readBlocks")(function* (raw: unknown) {
    const environmentId = yield* admit();
    const input = yield* validateRaw(raw).pipe(
      Effect.flatMap(decodeBlocks),
      Effect.mapError((e) =>
        isServiceError(e) ? e : new C.SpaceValidationError({ reason: "invalid_input" }),
      ),
    );
    yield* checkEnvironment(environmentId, input.environmentId);
    return yield* read(environmentId, () =>
      Effect.gen(function* () {
        yield* checkIds(input);
        const page = yield* getPageRow(input.pageId);
        yield* PageStore.assertActive(page);
        yield* Liveness.assertPageLive(page.page_id);
        if (input.revision < page.body_revision || input.revision > page.revision)
          return yield* new C.SpaceCursorStaleError({ revision: page.revision });
        const limit = input.limit ?? limits.maxBlockWindowBlocks;
        yield* ensureLimit("maxBlockWindowBlocks", limit);
        const cursor = yield* cursorFrom(
          input.cursor,
          environmentId,
          "readBlocks",
          input.pageId,
          page.body_revision,
        );
        const after = cursor ? { id: cursor.id, rank: cursor.key } : undefined;
        return yield* BlockStore.readWindow({
          pageId: input.pageId,
          revision: page.revision,
          after,
          limit,
          continuation: (row) =>
            cursorFor(
              environmentId,
              "readBlocks",
              input.pageId,
              page.body_revision,
              row.rank,
              row.block_id,
            ),
        });
      }),
    );
  });
  const inspectStructure = Effect.fn("SpacesService.inspectStructure")(function* (raw: unknown) {
    const environmentId = yield* admit();
    const input = yield* validateRaw(raw).pipe(
      Effect.flatMap(decodeInspect),
      Effect.mapError((error) =>
        isServiceError(error) ? error : new C.SpaceValidationError({ reason: "invalid_input" }),
      ),
    );
    yield* checkEnvironment(environmentId, input.environmentId);
    return yield* read(environmentId, (meta) =>
      Effect.gen(function* () {
        yield* checkIds(input);
        yield* ensureLimit("maxMutationBytes", byteLength(input));
        const plan = yield* PageStructure.plan(input, byteLength(input));
        if (input.recovery === "permanentlyDelete") yield* PageRecovery.prepare(plan);
        const result: C.SpaceInspectStructureResult = {
          ...(input.recovery
            ? { recovery: { operation: input.recovery, pageIds: [...plan.recoveryPages] } }
            : {}),
          catalogRevision: meta.catalog_revision,
          guards: plan.guards,
          pages: [...plan.pages.values()].map((row) =>
            PageStore.summary(row, input.recovery !== undefined),
          ),
          blockIds: [...plan.blocks.keys()].map((id) => C.SpaceBlockId.make(id)),
        };
        yield* ensureLimit("maxBlockWindowResponseBytes", byteLength(result));
        return result;
      }),
    );
  });
  const resolveReference = Effect.fn("SpacesService.resolveReference")(function* (raw: unknown) {
    const environmentId = yield* admit();
    const input = yield* validateRaw(raw).pipe(
      Effect.flatMap(decodeReference),
      Effect.mapError((error) =>
        isServiceError(error) ? error : new C.SpaceValidationError({ reason: "invalid_input" }),
      ),
    );
    yield* checkEnvironment(environmentId, input.environmentId);
    yield* checkIds(input);
    yield* ensureLimit("maxMutationBytes", byteLength(input));
    return yield* read(environmentId, () => ReferenceStore.resolve(input.target));
  });
  const captureContextSnapshot = Effect.fn("SpacesService.captureContextSnapshot")(function* (
    raw: unknown,
  ) {
    const environmentId = yield* admit();
    const input = yield* validateRaw(raw).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(SpaceContextCaptureInput, strict)),
      Effect.mapError((error) =>
        isServiceError(error) ? error : new C.SpaceValidationError({ reason: "invalid_input" }),
      ),
    );
    yield* checkEnvironment(environmentId, input.environmentId);
    yield* ensureLimit("maxMutationBytes", byteLength(input), 2_048);
    return yield* read(environmentId, () => ContextSnapshot.capture(input));
  });
  return {
    search,
    getPage,
    readBlocks,
    inspectStructure,
    resolveReference,
    captureContextSnapshot,
  };
};
