// @effect-diagnostics nodeBuiltinImport:off -- stable IDs are allocated by the platform cryptographic generator.
import * as NodeCrypto from "node:crypto";

import { EnvironmentId } from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import type * as SqlError from "effect/sql/SqlError";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as BlockStore from "./BlockStore.ts";
import { byteLength, canonical, checkLimit, limits } from "./CorePolicy.ts";
import * as Receipts from "./Receipts.ts";
import * as RevisionStore from "./RevisionStore.ts";
import * as PageStore from "./PageStore.ts";
import * as PageStructure from "./PageStructure.ts";
import * as ReferenceStore from "./ReferenceStore.ts";
import * as SpacesSql from "./SpacesSql.ts";
import * as Sqlite from "./Sqlite.ts";

export class SpacesService extends Context.Service<
  SpacesService,
  {
    readonly getCapability: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<C.SpaceCapability | null, C.SpaceServiceError>;
    // Inputs remain raw until the service's strict, size-bounded decoding boundary.
    readonly listSpaces: (input: unknown) => Effect.Effect<C.SpaceListResult, C.SpaceServiceError>;
    readonly listPages: (
      input: unknown,
    ) => Effect.Effect<C.SpacePageListResult, C.SpaceServiceError>;
    readonly getPage: (input: unknown) => Effect.Effect<C.SpacePageGetResult, C.SpaceServiceError>;
    readonly readBlocks: (
      input: unknown,
    ) => Effect.Effect<C.SpaceReadBlocksResult, C.SpaceServiceError>;
    readonly createSpace: (
      input: unknown,
    ) => Effect.Effect<C.SpaceCreateResult, C.SpaceServiceError>;
    readonly renameSpace: (
      input: unknown,
    ) => Effect.Effect<C.SpaceRenameResult, C.SpaceServiceError>;
    readonly setDefaultSpace: (
      input: unknown,
    ) => Effect.Effect<C.SpaceSetDefaultResult, C.SpaceServiceError>;
    readonly createPage: (
      input: unknown,
    ) => Effect.Effect<C.SpacePageCreateResult, C.SpaceServiceError>;
    readonly updatePage: (
      input: unknown,
    ) => Effect.Effect<C.SpacePageUpdateResult, C.SpaceServiceError>;
    readonly applyBlockBatch: (
      input: unknown,
    ) => Effect.Effect<C.SpaceApplyBlockBatchResult, C.SpaceServiceError>;
    readonly createChildPage: (
      input: unknown,
    ) => Effect.Effect<C.SpaceCreateChildPageResult, C.SpaceServiceError>;
    readonly movePage: (
      input: unknown,
    ) => Effect.Effect<C.SpaceMovePageResult, C.SpaceServiceError>;
    readonly inspectStructure: (
      input: unknown,
    ) => Effect.Effect<C.SpaceInspectStructureResult, C.SpaceServiceError>;
    readonly moveBlocks: (
      input: unknown,
    ) => Effect.Effect<C.SpaceMoveBlocksResult, C.SpaceServiceError>;
    readonly resolveReference: (
      input: unknown,
    ) => Effect.Effect<C.SpaceReferenceResolveResult, C.SpaceServiceError>;
    readonly lookupMutationReceipt: (
      input: unknown,
    ) => Effect.Effect<C.SpaceReceiptLookupResult, C.SpaceServiceError>;
  }
>()("@t2code/cli/spaces/SpacesService") {}

interface SpaceRow {
  readonly space_id: C.SpaceId;
  readonly title: string;
  readonly is_default: number;
  readonly revision: number;
  readonly root_order_revision: number;
  readonly created_at: string;
  readonly updated_at: string;
}
type PageRow = PageStore.PageRow;
const spaceSummary = (row: SpaceRow): C.SpaceSummary => ({
  id: row.space_id,
  title: row.title,
  isDefault: row.is_default === 1,
  revision: row.revision,
  rootOrderRevision: row.root_order_revision,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
const pageSummary = PageStore.summary;
const pagePreimage = (row: PageRow): RevisionStore.PagePreimage => ({
  pageId: row.page_id,
  spaceId: row.space_id,
  title: row.title,
  revision: row.revision,
  rootOrder: row.root_order,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
const strict = { onExcessProperty: "error" } as const;
const decodeList = Schema.decodeUnknownEffect(C.SpaceListInput, strict);
const decodePages = Schema.decodeUnknownEffect(C.SpacePageListInput, strict);
const decodeGet = Schema.decodeUnknownEffect(C.SpacePageGetInput, strict);
const decodeReference = Schema.decodeUnknownEffect(C.SpaceReferenceResolveInput, strict);
const decodeMoveBlocksResult = Schema.decodeUnknownSync(C.SpaceMoveBlocksResult, strict);
const decodeInspect = Schema.decodeUnknownEffect(C.SpaceInspectStructureInput, strict);
const decodeBlocks = Schema.decodeUnknownEffect(C.SpaceReadBlocksInput, strict);
const decodeRequest = Schema.decodeUnknownEffect(C.SpaceMutationRequest, strict);
const decodeLookup = Schema.decodeUnknownEffect(C.SpaceReceiptLookupInput, strict);
const decodeReceipt = Schema.decodeUnknownSync(C.SpaceMutationReceipt, strict);
const decodeCreateResult = Schema.decodeUnknownSync(C.SpaceCreateResult, strict);
const decodeRenameResult = Schema.decodeUnknownSync(C.SpaceRenameResult, strict);
const decodeDefaultResult = Schema.decodeUnknownSync(C.SpaceSetDefaultResult, strict);
const decodePageCreateResult = Schema.decodeUnknownSync(C.SpacePageCreateResult, strict);
const decodePageUpdateResult = Schema.decodeUnknownSync(C.SpacePageUpdateResult, strict);
const decodeApplyResult = Schema.decodeUnknownSync(C.SpaceApplyBlockBatchResult, strict);
const decodeCreateChildResult = Schema.decodeUnknownSync(C.SpaceCreateChildPageResult, strict);
const decodeMovePageResult = Schema.decodeUnknownSync(C.SpaceMovePageResult, strict);
const isServiceError = Schema.is(C.SpaceServiceError);
const Cursor = Schema.Struct({
  environmentId: EnvironmentId,
  operation: Schema.String,
  filter: Schema.String,
  revision: Schema.Int,
  key: Schema.String,
  id: Schema.String,
});
const decodeCursor = Schema.decodeUnknownSync(Cursor, strict);

const parseRaw = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

const validateRaw = Effect.fn("SpacesService.validateRaw")((raw: unknown) =>
  Effect.try({
    try: () => parseRaw(canonical(raw)),
    catch: (cause) =>
      isServiceError(cause) ? cause : new C.SpaceValidationError({ reason: "invalid_input" }),
  }),
);

function cursorFor(
  environmentId: EnvironmentId,
  operation: string,
  filter: string,
  revision: number,
  key: string,
  id: string,
) {
  const cursor = Buffer.from(
    canonical({ environmentId, operation, filter, revision, key, id }),
  ).toString("base64url");
  checkLimit("maxCursorBytes", byteLength(cursor));
  return C.SpaceCursor.make(cursor);
}
function cursorFrom(
  cursor: C.SpaceCursor | undefined,
  environmentId: EnvironmentId,
  operation: string,
  filter: string,
  revision: number,
) {
  if (cursor === undefined) return undefined;
  checkLimit("maxCursorBytes", byteLength(cursor));
  let decoded: typeof Cursor.Type;
  try {
    decoded = decodeCursor(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch {
    throw new C.SpaceValidationError({ reason: "invalid_cursor" });
  }
  if (
    decoded.environmentId !== environmentId ||
    decoded.operation !== operation ||
    decoded.filter !== filter
  )
    throw new C.SpaceValidationError({ reason: "invalid_cursor" });
  if (decoded.revision !== revision) throw new C.SpaceCursorStaleError({ revision });
  return decoded;
}
function checkIds(input: object) {
  for (const [key, value] of Object.entries(input)) {
    if (key.endsWith("Id") || key === "receiptEpoch") checkLimit("maxIdBytes", byteLength(value));
  }
}

const make = Effect.fn("SpacesService.make")(function* (dbPath: string) {
  const settings = yield* ServerSettings.ServerSettingsService;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const scope = yield* Effect.scope;
  const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const mutex = yield* Semaphore.make(1);
  const acquire = yield* Effect.cached(
    Layer.buildWithScope(Sqlite.layerFromPath(dbPath), scope).pipe(
      Effect.provide(platform),
      Effect.map((context) => Context.get(context, SpacesSql.SpacesSql)),
      Effect.mapError(() => new C.SpacesUnavailableError({ stage: "initializing" })),
    ),
  );
  const admit = Effect.fn("SpacesService.admit")(function* () {
    const snapshot = yield* settings.getSettings.pipe(
      Effect.mapError(() => new C.SpacesUnavailableError({ stage: "settings" })),
    );
    if (!snapshot.spacesEnabled) return yield* new C.SpacesDisabledError();
    // A positive snapshot admits this call; disabling later does not cancel an accepted transaction.
    return yield* identity.getEnvironmentId;
  });
  const checkEnvironment = Effect.fn("SpacesService.checkEnvironment")(function* (
    actual: EnvironmentId,
    requested: EnvironmentId,
  ) {
    if (actual !== requested) {
      const size = byteLength(requested);
      if (size > limits.maxIdBytes)
        return yield* new C.SpaceLimitExceededError({
          limit: "maxIdBytes",
          actual: size,
          maximum: limits.maxIdBytes,
        });
      return yield* new C.SpaceEnvironmentMismatchError({ environmentId: requested });
    }
  });
  const run = Effect.fn("SpacesService.transaction")(function* <A>(
    environmentId: EnvironmentId,
    use: (
      meta: Receipts.Metadata,
      replay?: C.SpaceMutationReceipt,
    ) => Effect.Effect<A, C.SpaceServiceError | SqlError.SqlError, SpacesSql.SpacesSql>,
    maintenance: true | C.SpaceMutationRequest = true,
  ) {
    const sql = yield* acquire;
    return yield* mutex.withPermits(1)(
      Effect.gen(function* () {
        // Commit the observed clock even when the subsequent request is refused or rolled back.
        const meta = yield* sql.withTransaction(Receipts.observe(environmentId));
        const replay =
          maintenance === true ? undefined : yield* sql.withTransaction(Receipts.find(maintenance));
        if (!replay) {
          if (maintenance === true) yield* sql.withTransaction(Receipts.cleanup(meta));
          yield* sql.withTransaction(RevisionStore.prune(meta.observed_time_ms));
          yield* sql.withTransaction(ReferenceStore.maintain());
        }
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const [current] =
              yield* sql<Receipts.Metadata>`SELECT * FROM spaces_core WHERE singleton = 1`;
            if (!current) return yield* new C.SpacesUnavailableError({ stage: "storage" });
            return yield* use(current, replay);
          }),
        );
      }).pipe(
        Effect.provideService(SpacesSql.SpacesSql, sql),
        Effect.catchTags({
          SqlError: () => Effect.fail(new C.SpacesUnavailableError({ stage: "storage" })),
        }),
        Effect.catchDefect((cause) =>
          Effect.fail(
            isServiceError(cause) ? cause : new C.SpacesUnavailableError({ stage: "storage" }),
          ),
        ),
      ),
    );
  });
  const getSpace = Effect.fn("SpacesService.space")(function* (id: C.SpaceId) {
    const sql = yield* SpacesSql.SpacesSql;
    const [row] = yield* sql<SpaceRow>`SELECT * FROM spaces WHERE space_id = ${id}`;
    if (!row) return yield* new C.SpaceNotFoundError({ entity: "space", id });
    return row;
  });
  const getPageRow = PageStore.read;
  const defaultSpace = Effect.fn("SpacesService.default")(function* () {
    const sql = yield* SpacesSql.SpacesSql;
    const [row] = yield* sql<SpaceRow>`SELECT * FROM spaces WHERE is_default = 1`;
    if (!row) return yield* new C.SpacesUnavailableError({ stage: "storage" });
    return row;
  });
  const listSpaces = Effect.fn("SpacesService.listSpaces")(function* (raw: unknown) {
    const environmentId = yield* admit();
    const input = yield* validateRaw(raw).pipe(
      Effect.flatMap(decodeList),
      Effect.mapError((e) =>
        isServiceError(e) ? e : new C.SpaceValidationError({ reason: "invalid_input" }),
      ),
    );
    yield* checkEnvironment(environmentId, input.environmentId);
    return yield* run(environmentId, (meta) =>
      Effect.gen(function* () {
        const sql = yield* SpacesSql.SpacesSql;
        checkIds(input);
        const limit = input.limit ?? limits.maxListRows;
        checkLimit("maxListRows", limit);
        const cursor = cursorFrom(
          input.cursor,
          environmentId,
          "listSpaces",
          "",
          meta.catalog_revision,
        );
        const rows = cursor
          ? yield* sql<SpaceRow>`SELECT * FROM spaces WHERE (created_at, space_id) > (${cursor.key}, ${cursor.id}) ORDER BY created_at, space_id LIMIT ${limit + 1}`
          : yield* sql<SpaceRow>`SELECT * FROM spaces ORDER BY created_at, space_id LIMIT ${limit + 1}`;
        const admission = yield* Receipts.issue(meta);
        const def = yield* defaultSpace();
        let take = Math.min(limit, rows.length);
        while (true) {
          const last = rows[take - 1];
          const result: C.SpaceListResult = {
            items: rows.slice(0, take).map(spaceSummary),
            defaultSpaceId: def.space_id,
            catalogRevision: meta.catalog_revision,
            nextCursor:
              take < rows.length && last
                ? cursorFor(
                    environmentId,
                    "listSpaces",
                    "",
                    meta.catalog_revision,
                    last.created_at,
                    last.space_id,
                  )
                : null,
            mutationAdmission: admission,
          };
          const size = byteLength(result);
          if (size <= limits.maxListResponseBytes) return result;
          if (take <= 1) {
            checkLimit("maxListResponseBytes", size);
          }
          take--;
        }
      }),
    );
  });
  const listPages = Effect.fn("SpacesService.listPages")(function* (raw: unknown) {
    const environmentId = yield* admit();
    const input = yield* validateRaw(raw).pipe(
      Effect.flatMap(decodePages),
      Effect.mapError((e) =>
        isServiceError(e) ? e : new C.SpaceValidationError({ reason: "invalid_input" }),
      ),
    );
    yield* checkEnvironment(environmentId, input.environmentId);
    return yield* run(environmentId, (meta) =>
      Effect.gen(function* () {
        const sql = yield* SpacesSql.SpacesSql;
        checkIds(input);
        const space = yield* getSpace(input.spaceId);
        const limit = input.limit ?? limits.maxListRows;
        checkLimit("maxListRows", limit);
        if (
          input.parentPageId !== undefined &&
          (yield* getPageRow(input.parentPageId)).space_id !== input.spaceId
        )
          return yield* new C.SpaceNotFoundError({ entity: "page", id: input.parentPageId });
        const filter = canonical({
          spaceId: input.spaceId,
          parentPageId: input.parentPageId ?? null,
        });
        const cursor = cursorFrom(
          input.cursor,
          environmentId,
          "listPages",
          filter,
          meta.catalog_revision,
        );
        const after =
          cursor === undefined
            ? sql``
            : input.parentPageId === undefined
              ? sql`AND (p.root_order,p.page_id) > (${cursor.key},${cursor.id})`
              : sql`AND (b.rank,b.block_id) > (${cursor.key},${cursor.id})`;
        const rows =
          input.parentPageId === undefined
            ? yield* sql<
                PageRow & { readonly list_order: string; readonly list_id: string }
              >`SELECT p.*, p.root_order AS list_order, p.page_id AS list_id, o.owner_block_id, b.page_id AS parent_page_id, b.deleted AS owner_deleted, parent.space_id AS parent_space_id, json_extract(b.payload,'$.type') AS owner_type
              FROM spaces_pages p LEFT JOIN spaces_page_owners o ON o.child_page_id = p.page_id
              LEFT JOIN spaces_blocks b ON b.block_id = o.owner_block_id LEFT JOIN spaces_pages parent ON parent.page_id = b.page_id WHERE p.space_id = ${input.spaceId} AND p.root_order IS NOT NULL
              ${after}
              ORDER BY p.root_order,p.page_id LIMIT ${limit + 1}`
            : yield* sql<
                PageRow & { readonly list_order: string; readonly list_id: string }
              >`SELECT p.*, b.rank AS list_order, b.block_id AS list_id, o.owner_block_id,
              b.page_id AS parent_page_id, b.deleted AS owner_deleted, parent.space_id AS parent_space_id,
              json_extract(b.payload,'$.type') AS owner_type FROM spaces_blocks b
              JOIN spaces_page_owners o ON o.owner_block_id = b.block_id JOIN spaces_pages p ON p.page_id = o.child_page_id
              JOIN spaces_pages parent ON parent.page_id = b.page_id
              WHERE b.page_id = ${input.parentPageId} AND b.deleted = 0 AND json_extract(b.payload,'$.type') = 'child_page'
              AND p.space_id = ${input.spaceId}
              ${after}
              ORDER BY b.rank,b.block_id LIMIT ${limit + 1}`;
        const admission = yield* Receipts.issue(meta);
        let take = Math.min(limit, rows.length);
        while (true) {
          const last = rows[take - 1];
          const result: C.SpacePageListResult = {
            space: spaceSummary(space),
            items: rows.slice(0, take).map(pageSummary),
            catalogRevision: meta.catalog_revision,
            nextCursor:
              take < rows.length && last
                ? cursorFor(
                    environmentId,
                    "listPages",
                    filter,
                    meta.catalog_revision,
                    last.list_order,
                    last.list_id,
                  )
                : null,
            mutationAdmission: admission,
          };
          const size = byteLength(result);
          if (size <= limits.maxListResponseBytes) return result;
          if (take <= 1) checkLimit("maxListResponseBytes", size);
          take--;
        }
      }),
    );
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
    return yield* run(environmentId, (meta) =>
      Effect.gen(function* () {
        checkIds(input);
        const page = yield* getPageRow(input.pageId);
        const space = yield* getSpace(page.space_id);
        const result = {
          page: pageSummary(page),
          space: spaceSummary(space),
          mutationAdmission: yield* Receipts.issue(meta),
        };
        checkLimit("maxListResponseBytes", byteLength(result));
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
    return yield* run(environmentId, () =>
      Effect.gen(function* () {
        const sql = yield* SpacesSql.SpacesSql;
        checkIds(input);
        const page = yield* getPageRow(input.pageId);
        if (page.revision !== input.revision)
          return yield* new C.SpaceCursorStaleError({ revision: page.revision });
        const limit = input.limit ?? limits.maxBlockWindowBlocks;
        checkLimit("maxBlockWindowBlocks", limit);
        const cursor = cursorFrom(
          input.cursor,
          environmentId,
          "readBlocks",
          input.pageId,
          page.revision,
        );
        const firstChild = Effect.fnUntraced(function* (parent: string | null) {
          const [row] =
            yield* sql<BlockStore.BlockRow>`SELECT * FROM spaces_blocks WHERE page_id = ${input.pageId} AND deleted = 0 AND parent_id IS ${parent} ORDER BY rank, block_id LIMIT 1`;
          return row;
        });
        const successor = Effect.fnUntraced(function* (row: BlockStore.BlockRow) {
          const child = yield* firstChild(row.block_id);
          if (child) return child;
          const seen = new Set<string>();
          let node = row;
          while (true) {
            if (seen.has(node.block_id))
              return yield* new C.SpaceValidationError({ reason: "cycle" });
            seen.add(node.block_id);
            checkLimit("maxDepth", seen.size);
            const [sibling] =
              yield* sql<BlockStore.BlockRow>`SELECT * FROM spaces_blocks WHERE page_id = ${input.pageId} AND deleted = 0 AND parent_id IS ${node.parent_id} AND (rank, block_id) > (${node.rank}, ${node.block_id}) ORDER BY rank, block_id LIMIT 1`;
            if (sibling) return sibling;
            if (node.parent_id === null) return undefined;
            const [parent] =
              yield* sql<BlockStore.BlockRow>`SELECT * FROM spaces_blocks WHERE page_id = ${input.pageId} AND deleted = 0 AND block_id = ${node.parent_id}`;
            if (!parent) return yield* new C.SpaceValidationError({ reason: "invalid_parent" });
            node = parent;
          }
        });
        let row: BlockStore.BlockRow | undefined;
        if (cursor) {
          const [last] =
            yield* sql<BlockStore.BlockRow>`SELECT * FROM spaces_blocks WHERE block_id = ${cursor.id} AND page_id = ${input.pageId} AND deleted = 0`;
          if (!last || last.rank !== cursor.key)
            return yield* new C.SpaceValidationError({ reason: "invalid_cursor" });
          row = yield* successor(last);
        } else row = yield* firstChild(null);
        const blocks: C.SpaceBlock[] = [];
        const seen = new Set<string>();
        let nextCursor: C.SpaceCursor | null = null;
        while (row && blocks.length < limit) {
          if (seen.has(row.block_id)) return yield* new C.SpaceValidationError({ reason: "cycle" });
          seen.add(row.block_id);
          const next = yield* successor(row);
          const candidate = [...blocks, yield* BlockStore.blockFromRow(row)];
          const continuation = next
            ? cursorFor(
                environmentId,
                "readBlocks",
                input.pageId,
                page.revision,
                row.rank,
                row.block_id,
              )
            : null;
          const size = byteLength({
            revision: page.revision,
            blocks: candidate,
            nextCursor: continuation,
          });
          if (size > limits.maxBlockWindowResponseBytes) {
            if (!blocks.length) checkLimit("maxBlockWindowResponseBytes", size);
            break;
          }
          blocks.push(candidate[candidate.length - 1]!);
          nextCursor = continuation;
          row = next;
        }
        return { revision: page.revision, blocks, nextCursor };
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
    return yield* run(environmentId, (meta) =>
      Effect.gen(function* () {
        checkIds(input);
        checkLimit("maxMutationBytes", byteLength(input));
        const plan = yield* PageStructure.plan(input, byteLength(input));
        const result: C.SpaceInspectStructureResult = {
          catalogRevision: meta.catalog_revision,
          guards: plan.guards,
          pages: [...plan.pages.values()].map(pageSummary),
          blockIds: [...plan.blocks.keys()].map((id) => C.SpaceBlockId.make(id)),
        };
        checkLimit("maxBlockWindowResponseBytes", byteLength(result));
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
    checkIds(input);
    checkLimit("maxMutationBytes", byteLength(input));
    return yield* run(environmentId, () => ReferenceStore.resolve(input.target));
  });
  const execute = Effect.fn("SpacesService.execute")(function* (
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
          pages: pages.map(pageSummary),
        },
      };
    });
    const changed = Effect.fnUntraced(function* () {
      yield* sql`UPDATE spaces_core SET catalog_revision = catalog_revision + 1 WHERE singleton = 1`;
    });
    switch (request.operation) {
      case "createChildPage":
      case "moveBlocks":
      case "movePage": {
        const structural =
          request.operation === "moveBlocks"
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
        if (!PageStructure.guardsMatch(plan, request.input.guards)) {
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
        const result = yield* PageStructure.apply(
          plan,
          request.input.mutationId,
          meta.observed_time_ms,
          request.operation === "createChildPage" ? request.input.title : undefined,
        );
        return decodeReceipt({
          operation: request.operation,
          result: { status: "saved", ...ack, ...result },
        });
      }
      case "createSpace": {
        const input = request.input;
        const id = C.SpaceId.make(NodeCrypto.randomUUID());
        yield* sql`INSERT INTO spaces_ids (id, kind) VALUES (${id}, 'space')`;
        yield* sql`INSERT INTO spaces (space_id, title, is_default, created_at, updated_at) VALUES (${id}, ${input.title}, 0, ${now}, ${now})`;
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
        if (rank >= 1n << 128n)
          return yield* new C.SpaceValidationError({ reason: "invalid_order" });
        const id = C.SpacePageId.make(NodeCrypto.randomUUID());
        yield* sql`INSERT INTO spaces_ids (id, kind) VALUES (${id}, 'page')`;
        yield* sql`INSERT INTO spaces_pages (page_id, space_id, title, root_order, created_at, updated_at)
          VALUES (${id}, ${input.spaceId}, ${input.title}, ${rank.toString(16).padStart(32, "0")}, ${now}, ${now})`;
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
        if (page.revision !== input.baseRevision)
          return decodeReceipt({
            operation: request.operation,
            result: yield* conflict([yield* getSpace(page.space_id)], [page]),
          });
        if (page.title !== input.title) {
          yield* sql`UPDATE spaces_pages SET title = ${input.title}, revision = revision + 1, updated_at = ${now} WHERE page_id = ${input.pageId}`;
          yield* RevisionStore.capture(
            {
              pageId: input.pageId,
              toRevision: page.revision + 1,
              mutationId: input.mutationId,
              pageBefore: pagePreimage(page),
              blocksBefore: [],
            },
            meta.observed_time_ms,
          );
          yield* changed();
        }
        return decodeReceipt({
          operation: request.operation,
          result: { status: "saved", ...ack, page: pageSummary(yield* getPageRow(input.pageId)) },
        });
      }
      case "applyBlockBatch": {
        const input = request.input;
        const page = yield* getPageRow(input.pageId);
        if (page.revision !== input.baseRevision)
          return decodeReceipt({
            operation: request.operation,
            result: {
              ...(yield* conflict([yield* getSpace(page.space_id)], [page])),
              generation: input.generation,
              revision: page.revision,
            },
          });
        const result = yield* BlockStore.apply(
          input.pageId,
          input.mutations,
          page.block_count,
          page.block_bytes,
          byteLength(request),
        );
        if (result.changed) {
          yield* sql`UPDATE spaces_pages SET revision = revision + 1, block_count = ${result.count}, block_bytes = ${result.bytes}, updated_at = ${now} WHERE page_id = ${input.pageId}`;
          yield* RevisionStore.capture(
            {
              pageId: input.pageId,
              toRevision: page.revision + 1,
              mutationId: input.mutationId,
              pageBefore: pagePreimage(page),
              blocksBefore: result.blocksBefore,
            },
            meta.observed_time_ms,
          );
          yield* ReferenceStore.release(result.retiredIds);
          yield* changed();
        }
        return decodeReceipt({
          operation: request.operation,
          result: {
            status: "saved",
            ...ack,
            generation: input.generation,
            revision: page.revision + (result.changed ? 1 : 0),
          },
        });
      }
    }
  });
  const mutate = Effect.fn("SpacesService.mutate")(function* (
    operation: C.SpaceMutationRequest["operation"],
    raw: unknown,
  ) {
    const environmentId = yield* admit();
    const request = yield* validateRaw({ operation, input: raw }).pipe(
      Effect.flatMap(decodeRequest),
      Effect.mapError((e) =>
        isServiceError(e) ? e : new C.SpaceValidationError({ reason: "invalid_input" }),
      ),
    );
    yield* checkEnvironment(environmentId, request.input.environmentId);
    return yield* run(
      environmentId,
      (meta, replay) =>
        Effect.gen(function* () {
          const found = replay ?? (yield* Receipts.find(request));
          if (found) return found;
          checkLimit("maxMutationBytes", byteLength(request));
          checkIds(request.input);
          if ("title" in request.input)
            checkLimit("maxTitleBytes", byteLength(request.input.title));
          if (request.operation === "applyBlockBatch")
            checkLimit("maxMutationNodes", request.input.mutations.length);
          const epoch = yield* Receipts.active(meta);
          if (!epoch || epoch.epoch !== request.input.receiptEpoch)
            return yield* new C.SpaceMutationAdmissionError({
              receiptEpoch: request.input.receiptEpoch,
            });
          const receipt = yield* execute(request, meta);
          yield* Receipts.store(request, receipt, meta, epoch.retain_until);
          return receipt;
        }),
      request,
    );
  });
  const createSpace = Effect.fn("SpacesService.createSpace")(function* (input: unknown) {
    return decodeCreateResult((yield* mutate("createSpace", input)).result);
  });
  const renameSpace = Effect.fn("SpacesService.renameSpace")(function* (input: unknown) {
    return decodeRenameResult((yield* mutate("renameSpace", input)).result);
  });
  const setDefaultSpace = Effect.fn("SpacesService.setDefaultSpace")(function* (input: unknown) {
    return decodeDefaultResult((yield* mutate("setDefaultSpace", input)).result);
  });
  const createPage = Effect.fn("SpacesService.createPage")(function* (input: unknown) {
    return decodePageCreateResult((yield* mutate("createPage", input)).result);
  });
  const updatePage = Effect.fn("SpacesService.updatePage")(function* (input: unknown) {
    return decodePageUpdateResult((yield* mutate("updatePage", input)).result);
  });
  const applyBlockBatch = Effect.fn("SpacesService.applyBlockBatch")(function* (input: unknown) {
    return decodeApplyResult((yield* mutate("applyBlockBatch", input)).result);
  });
  const createChildPage = Effect.fn("SpacesService.createChildPage")(function* (input: unknown) {
    return decodeCreateChildResult((yield* mutate("createChildPage", input)).result);
  });
  const movePage = Effect.fn("SpacesService.movePage")(function* (input: unknown) {
    return decodeMovePageResult((yield* mutate("movePage", input)).result);
  });
  const moveBlocks = Effect.fn("SpacesService.moveBlocks")(function* (input: unknown) {
    return decodeMoveBlocksResult((yield* mutate("moveBlocks", input)).result);
  });
  const lookupMutationReceipt = Effect.fn("SpacesService.lookupMutationReceipt")(function* (
    raw: unknown,
  ): Effect.fn.Return<C.SpaceReceiptLookupResult, C.SpaceServiceError> {
    const environmentId = yield* admit();
    const input = yield* validateRaw(raw).pipe(
      Effect.flatMap(decodeLookup),
      Effect.mapError((e) =>
        isServiceError(e) ? e : new C.SpaceValidationError({ reason: "invalid_input" }),
      ),
    );
    yield* checkEnvironment(environmentId, input.request.input.environmentId);
    return yield* run(
      environmentId,
      (meta, replay) =>
        Effect.gen(function* () {
          const receipt = replay ?? (yield* Receipts.find(input.request));
          if (receipt) return { status: "found" as const, receipt };
          checkIds(input.request.input);
          const epoch = yield* Receipts.active(meta);
          return {
            status:
              epoch?.epoch === input.request.input.receiptEpoch
                ? ("absent" as const)
                : ("unknown" as const),
          };
        }),
      input.request,
    );
  });
  const getCapability = Effect.fn("SpacesService.getCapability")(
    function* (requested: EnvironmentId) {
      const environmentId = yield* admit();
      yield* checkEnvironment(environmentId, requested);
      return yield* run(environmentId, (meta) =>
        Effect.gen(function* () {
          yield* Receipts.issue(meta);
          return { version: 2, limits };
        }),
      );
    },
    Effect.catchTags({
      SpacesDisabledError: () => Effect.succeed(null),
      SpacesUnavailableError: () => Effect.succeed(null),
    }),
  );
  return SpacesService.of({
    getCapability,
    listSpaces,
    listPages,
    getPage,
    readBlocks,
    createSpace,
    renameSpace,
    setDefaultSpace,
    createPage,
    updatePage,
    applyBlockBatch,
    lookupMutationReceipt,
    createChildPage,
    movePage,
    inspectStructure,
    moveBlocks,
    resolveReference,
  });
});

export const layerFromPath = (dbPath: string) => Layer.effect(SpacesService, make(dbPath));
