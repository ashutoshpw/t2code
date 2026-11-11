import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";

import type * as Receipts from "../Receipts.ts";
import * as PageStore from "../PageStore.ts";
import { decodeReceipt } from "../service/Helpers.ts";
import * as Definitions from "./computed/Definitions.ts";
import * as Settle from "./computed/Settle.ts";
import * as DatabaseStore from "./DatabaseStore.ts";
import * as RowStore from "./RowStore.ts";
import * as SchemaStore from "./SchemaStore.ts";
import * as Touched from "./Touched.ts";

type RowsRequest = Extract<
  C.SpaceMutationRequest,
  { readonly operation: "createRows" | "updateRows" | "moveRows" }
>;

/** Row creation, cell writes and manual order: last writer wins, no revision of the row body. */
export const rowsMutation = Effect.fn("SpacesDatabases.rowsMutation")(function* (
  request: RowsRequest,
  meta: Receipts.Metadata,
) {
  const now = meta.observed_time_ms;
  const ack = { mutationId: request.input.mutationId, receiptEpoch: request.input.receiptEpoch };
  const source = yield* DatabaseStore.getLiveDataSource(request.input.dataSourceId);
  const touched = Touched.touched();
  let snapshot = yield* SchemaStore.load(source.data_source_id);
  if (yield* Definitions.ensureCompiled({ now, touched }, snapshot))
    snapshot = yield* SchemaStore.load(source.data_source_id);
  switch (request.operation) {
    case "createRows": {
      const created = yield* RowStore.createRows({
        snapshot,
        drafts: request.input.rows,
        beforeRowId: request.input.beforeRowId ?? null,
        mutationId: request.input.mutationId,
        now,
        touched,
      });
      yield* Settle.settleAndDrain(touched);
      yield* RowStore.finish(touched, new Set(), now);
      const fresh = yield* DatabaseStore.getDataSource(source.data_source_id);
      return decodeReceipt({
        operation: request.operation,
        result: {
          status: "saved",
          ...ack,
          dataSourceId: source.data_source_id,
          dataRevision: fresh.data_revision,
          rows: created.map((row) => ({
            pageId: C.SpacePageId.make(row.pageId),
            number: row.number,
          })),
          affectedDataSourceIds: Touched.affected(touched, source.data_source_id).map((id) =>
            C.SpaceDataSourceId.make(id),
          ),
        },
      });
    }
    case "updateRows": {
      yield* RowStore.updateRows({
        snapshot,
        rows: request.input.rows,
        mutationId: request.input.mutationId,
        now,
        touched,
      });
      yield* Settle.settleAndDrain(touched);
      yield* RowStore.finish(touched, new Set(), now);
      const fresh = yield* DatabaseStore.getDataSource(source.data_source_id);
      const rows = [];
      for (const row of request.input.rows) {
        const page = yield* PageStore.load(row.pageId);
        rows.push({ pageId: row.pageId, revision: page.revision, updatedAt: page.updated_at });
      }
      return decodeReceipt({
        operation: request.operation,
        result: {
          status: "saved",
          ...ack,
          dataSourceId: source.data_source_id,
          dataRevision: fresh.data_revision,
          rows,
          affectedDataSourceIds: Touched.affected(touched, source.data_source_id).map((id) =>
            C.SpaceDataSourceId.make(id),
          ),
        },
      });
    }
    case "moveRows": {
      yield* RowStore.moveRows({
        snapshot,
        pageIds: request.input.pageIds,
        beforeRowId: request.input.beforeRowId,
        touched,
      });
      yield* Settle.settleAndDrain(touched);
      yield* RowStore.finish(touched, new Set(), now);
      const fresh = yield* DatabaseStore.getDataSource(source.data_source_id);
      return decodeReceipt({
        operation: request.operation,
        result: {
          status: "saved",
          ...ack,
          dataSourceId: source.data_source_id,
          dataRevision: fresh.data_revision,
        },
      });
    }
  }
});
