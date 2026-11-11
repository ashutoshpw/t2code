import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  SPACE_AGGREGATES_BY_TYPE,
  SPACE_FORMULA_TYPE_BY_PROPERTY,
  SPACE_FILTER_OPERATORS,
  SPACE_PROPERTY_TYPES,
  SPACE_VIEW_TYPES,
  SpaceCapability,
  SpaceDatabaseBlock,
  SpaceDatabaseError,
  SpaceDatabaseProperty,
  SpaceDatabaseRow,
  SpaceDatabaseQueryInput,
  SpaceDatabaseQueryResult,
  SpaceDatabaseView,
  SpaceFilter,
  SpaceGroupKey,
  SpaceKnownDatabaseProperty,
  SpaceKnownDatabaseView,
  SpaceKnownFilter,
  SpaceViewCreateInput,
  SpaceViewUpdateInput,
  SpaceKnownComputedValue,
  SpaceKnownPropertyConfig,
  SpaceDatabaseRowGetInput,
  SpaceDatabaseRowGetResult,
  spacePropertyQueryType,
  SpaceLimitExceededError,
  SpaceMutationReceipt,
  SpaceMutationRequest,
  SpacePageLocation,
  SpacePageSummary,
  SpaceServiceError,
  measureSpaceFilter,
} from "./spaces.ts";

const roundTrip = <S extends Schema.Top>(schema: S, value: unknown) =>
  // oxlint-disable-next-line t2code/no-inline-schema-compile -- a table helper over many schemas
  Schema.encodeUnknownSync(Schema.toCodecJson(schema) as never)(
    Schema.decodeUnknownSync(schema as never)(value),
  );
const decodes = (schema: Schema.Top, value: unknown) => {
  try {
    Schema.decodeUnknownSync(schema as never, { onExcessProperty: "error" })(value);
    return true;
  } catch {
    return false;
  }
};

const ack = { environmentId: "env", mutationId: "m1", receiptEpoch: "e1" };
const saved = { status: "saved", mutationId: "m1", receiptEpoch: "e1" };
const condition = { property: "abcd12", operator: "equals", value: "x" };

describe("Spaces databases forward compatibility", () => {
  it.each([
    [
      "property",
      SpaceDatabaseProperty,
      {
        id: "p1xx",
        name: "N",
        type: "future_geo",
        config: { radius: [1, 2] },
        position: 1,
        extra: 1,
      },
    ],
    [
      "view",
      SpaceDatabaseView,
      {
        id: "v",
        databaseId: "d",
        dataSourceId: "s",
        name: "Map",
        type: "future_map",
        position: 1,
        sorts: [{ property: "p1xx", direction: "descending", nulls: "first" }],
        group: { property: "p1xx", by: { future: true }, order: [{ kind: "future_key", a: 1 }] },
        properties: [{ propertyId: "p1xx", visible: true, aggregate: "future_fn", pin: true }],
        layout: { zoom: 3 },
        filter: { or: [{ property: "p1xx", operator: "future_op", value: { a: [1] } }] },
      },
    ],
    ["group key", SpaceGroupKey, { kind: "future_bucket", payload: { x: 1 } }],
    [
      "query result with unknown aggregate",
      SpaceDatabaseQueryResult,
      {
        dataSourceId: "s",
        schemaRevision: 1,
        dataRevision: 2,
        rows: [],
        aggregates: [{ property: "p1xx", function: "future_fn", number: 1, unit: "x" }],
        relatedPages: {},
        nextCursor: null,
      },
    ],
  ])("round-trips an unknown %s without loss", (_name, schema, value) => {
    expect(roundTrip(schema, value)).toEqual(value);
  });

  it("keeps the page location union closed and marks rows with an optional key", () => {
    expect(SpacePageLocation.members).toHaveLength(2);
    const summary = {
      id: "r",
      spaceId: "s",
      title: "Row",
      revision: 1,
      rootOrder: null,
      row: { dataSourceId: "ds" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(roundTrip(SpacePageSummary, summary)).toEqual(summary);
    const { row: _row, ...legacy } = summary;
    expect(roundTrip(SpacePageSummary, legacy)).toEqual(legacy);
  });

  it("decodes rows with and without the optional childCount and cover", () => {
    const row = {
      page: {
        id: "r",
        title: "Row",
        revision: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      number: 1,
      cells: {},
    };
    const OldRow = Schema.Struct({
      page: SpaceDatabaseRow.fields.page,
      number: SpaceDatabaseRow.fields.number,
      cells: SpaceDatabaseRow.fields.cells,
    });
    expect(roundTrip(SpaceDatabaseRow, row)).toEqual(row);
    const extras = { ...row, childCount: 2, cover: { assetId: "asset1" } };
    expect(roundTrip(SpaceDatabaseRow, extras)).toEqual(extras);
    // An older client's struct drops the new keys and still decodes the payload.
    expect(roundTrip(OldRow, extras)).toEqual(row);
    expect(SPACE_VIEW_TYPES).toContain("timeline");
    const query = {
      environmentId: "env",
      dataSourceId: "ds",
      mode: "rows",
      timeZone: "UTC",
      include: { cover: true },
    };
    expect(roundTrip(SpaceDatabaseQueryInput, query)).toEqual(query);
  });

  it("decodes older capabilities and the new database limit and error names", () => {
    expect(
      decodes(SpaceCapability, {
        version: 2,
        limits: {
          maxListRows: 1,
          maxListResponseBytes: 1,
          maxBlockWindowBlocks: 1,
          maxBlockWindowResponseBytes: 1,
          maxMutationNodes: 1,
          maxMutationBytes: 1,
          maxBlockBytes: 1,
          maxDepth: 1,
          maxPageBlocks: 1,
          maxPageBytes: 1,
          maxIdBytes: 1,
          maxTitleBytes: 1,
          maxOrderBytes: 1,
          maxCursorBytes: 1,
          maxReceiptBytes: 1,
          maxReceiptRows: 1,
          maxReceiptStorageBytes: 1,
          maxEpochRows: 1,
          receiptRetentionMs: 1,
          cleanupBatchRows: 1,
        },
      }),
    ).toBe(true);
    const limit = { _tag: "SpaceLimitExceededError", actual: 4, maximum: 3 };
    expect(decodes(SpaceLimitExceededError, { ...limit, limit: "databases.maxFilterDepth" })).toBe(
      true,
    );
    expect(decodes(SpaceLimitExceededError, { ...limit, limit: "databases.maxNothing" })).toBe(
      false,
    );
    const error = {
      _tag: "SpaceDatabaseError",
      reason: "property_not_queryable",
      propertyId: "p1xx",
    };
    expect(decodes(SpaceDatabaseError, error)).toBe(true);
    expect(decodes(SpaceServiceError, error)).toBe(true);
  });
});

describe("Spaces databases strict known shapes", () => {
  const prop = (type: string, config: unknown) => ({
    id: "p1xx",
    name: "N",
    type,
    config,
    position: 1,
  });

  it("accepts a valid config per type and rejects excess or wrong config", () => {
    const valid: Record<string, unknown> = {
      title: {},
      text: {},
      checkbox: {},
      url: {},
      email: {},
      phone: {},
      files: {},
      number: { format: "number_with_commas", decimals: 2, showAs: { kind: "bar", divideBy: 100 } },
      select: { options: [{ id: "o1aa", name: "A", color: "red" }] },
      multi_select: { options: [] },
      status: {
        options: [{ id: "o1aa", name: "A", color: "gray", group: "todo" }],
        defaultOptionId: "o1aa",
      },
      date: { dateFormat: "relative", timeFormat: "24h" },
      created_time: {},
      last_edited_time: { timeFormat: "hidden" },
      relation: { dataSourceId: "ds", limit: "many", twoWay: { propertyId: "p2xx" } },
      rollup: { relationPropertyId: "p2xx", targetPropertyId: "p3xx", function: "percent_checked" },
      formula: { expression: 'prop("a")' },
      unique_id: { prefix: "TASK" },
    };
    expect(Object.keys(valid).toSorted()).toEqual([...SPACE_PROPERTY_TYPES].toSorted());
    expect(Object.keys(SpaceKnownPropertyConfig).toSorted()).toEqual(
      [...SPACE_PROPERTY_TYPES].toSorted(),
    );
    for (const [type, config] of Object.entries(valid)) {
      expect(decodes(SpaceKnownDatabaseProperty, prop(type, config)), type).toBe(true);
      expect(
        decodes(SpaceKnownDatabaseProperty, prop(type, { ...(config as object), bogus: 1 })),
        type,
      ).toBe(false);
    }
    for (const [type, config] of [
      ["number", { format: "bitcoin" }],
      ["number", { format: "number", decimals: 11 }],
      ["number", { format: "number", showAs: { kind: "bar", divideBy: 0 } }],
      ["status", { options: [{ id: "o1aa", name: "A", color: "red" }] }],
      ["relation", { dataSourceId: "ds", limit: "some" }],
      ["unique_id", { prefix: "no-dash" }],
      ["unique_id", { prefix: "A".repeat(17) }],
      ["title", { options: [] }],
    ] as const) {
      expect(decodes(SpaceKnownDatabaseProperty, prop(type, config)), type).toBe(false);
    }
  });

  it("requires the date property of calendar and timeline layouts", () => {
    const view = (type: string, layout: unknown) => ({
      id: "v",
      databaseId: "d",
      dataSourceId: "s",
      name: "V",
      type,
      position: 1,
      sorts: [],
      properties: [],
      layout,
    });
    expect(
      decodes(SpaceKnownDatabaseView, view("table", { frozenColumns: 1, loadLimit: 25 })),
    ).toBe(true);
    expect(
      decodes(SpaceKnownDatabaseView, view("board", { cardPreview: { kind: "page_cover" } })),
    ).toBe(true);
    expect(decodes(SpaceKnownDatabaseView, view("calendar", { datePropertyId: "p1xx" }))).toBe(
      true,
    );
    expect(decodes(SpaceKnownDatabaseView, view("calendar", {}))).toBe(false);
    expect(decodes(SpaceKnownDatabaseView, view("timeline", { startPropertyId: "p1xx" }))).toBe(
      true,
    );
    expect(decodes(SpaceKnownDatabaseView, view("timeline", {}))).toBe(false);
    expect(decodes(SpaceKnownDatabaseView, view("table", { loadLimit: 7 }))).toBe(false);
    expect(decodes(SpaceKnownDatabaseView, view("future_map", {}))).toBe(false);
  });

  it("rejects unknown content in view mutation inputs and known views", () => {
    const base = { ...ack, dataSourceId: "ds", name: "v", type: "table", beforeViewId: null };
    const p = "abcd12";
    const cond = { property: p, operator: "equals", value: "x" };
    const good = [
      { sorts: [{ property: p, direction: "ascending" }] },
      { properties: [{ propertyId: p, visible: true, width: 3, aggregate: "sum" }] },
      { filter: { and: [cond, { or: [{ property: p, operator: "is_empty" }] }] } },
      { group: { property: p, by: "month", order: [{ kind: "empty" }] } },
    ];
    for (const extra of good)
      expect(decodes(SpaceViewCreateInput, { ...base, ...extra })).toBe(true);
    const bad = [
      { sorts: [{ property: p, direction: "ascending", junk: { a: 1 } }] },
      { properties: [{ propertyId: p, visible: true, widht: 3 }] },
      { properties: [{ propertyId: p, visible: true, aggregate: "bogus" }] },
      { filter: { and: [{ property: p, operator: "zzz" }] } },
      { filter: { and: [{ ...cond, extra: 1 }] } },
      { filter: { and: [], property: p, operator: "equals" } },
      { group: { property: p, by: { nonsense: 1 }, zzz: 1 } },
      { group: { property: p, by: "month", order: [{ kind: "future" }] } },
    ];
    for (const extra of bad) {
      expect(decodes(SpaceViewCreateInput, { ...base, ...extra })).toBe(false);
      expect(decodes(SpaceViewUpdateInput, { ...ack, viewId: "v", ...extra })).toBe(false);
    }
    expect(decodes(SpaceKnownFilter, { and: [], property: p, operator: "equals" })).toBe(false);
    expect(
      decodes(SpaceKnownDatabaseView, {
        id: "v1xx",
        databaseId: "d1xx",
        dataSourceId: "s1xx",
        name: "n",
        type: "table",
        position: 0,
        sorts: [{ property: p, direction: "ascending", junk: 1 }],
        properties: [],
        layout: {},
      }),
    ).toBe(false);
  });

  it("decodes a database block strictly", () => {
    const block = {
      id: "b",
      parentId: null,
      order: "a",
      type: "database",
      version: 1,
      content: { databaseId: "d", viewIds: ["v1", "v2"] },
    };
    expect(decodes(SpaceDatabaseBlock, block)).toBe(true);
    expect(decodes(SpaceDatabaseBlock, { ...block, content: { ...block.content, extra: 1 } })).toBe(
      false,
    );
  });

  it("covers every property type in the operator and aggregate tables", () => {
    for (const type of SPACE_PROPERTY_TYPES) {
      expect(SPACE_FILTER_OPERATORS[type], type).toBeDefined();
      expect(SPACE_AGGREGATES_BY_TYPE[type], type).toBeDefined();
    }
    expect(SPACE_FILTER_OPERATORS.formula).toEqual([]);
    expect(SPACE_FILTER_OPERATORS.created_time).not.toContain("is_empty");
  });
});

describe("Spaces database filters", () => {
  const decodeFilter = Schema.decodeUnknownSync(SpaceFilter);

  it("decodes nested groups and keeps conditions distinct from groups", () => {
    const filter = {
      and: [
        condition,
        { or: [condition, { and: [] }] },
        { property: "p2xx", operator: "future_op", value: [1] },
      ],
    };
    expect(roundTrip(SpaceFilter, filter)).toEqual(filter);
    expect(decodes(SpaceFilter, { and: [] })).toBe(true);
    // An object that is neither group nor condition must not decode as a condition.
    expect(decodes(SpaceFilter, { and: "no" })).toBe(false);
    expect(decodes(SpaceFilter, { or: [{ and: [{ nothing: true }] }] })).toBe(false);
    expect(decodes(SpaceFilter, { property: "p1xx" })).toBe(false);
    expect(decodes(SpaceFilter, { property: "p1xx", operator: "equals", part: "middle" })).toBe(
      false,
    );
  });

  it("measures group depth including the root and counts leaves", () => {
    expect(measureSpaceFilter(decodeFilter(condition))).toEqual({ depth: 0, conditions: 1 });
    expect(measureSpaceFilter(decodeFilter({ and: [] }))).toEqual({ depth: 1, conditions: 0 });
    const nested = decodeFilter({
      and: [condition, { or: [condition, { and: [condition, condition] }] }],
    });
    expect(measureSpaceFilter(nested)).toEqual({ depth: 3, conditions: 4 });
  });

  it("accepts an ad hoc query with relative dates and a within operand", () => {
    const query = {
      environmentId: "env",
      dataSourceId: "ds",
      mode: "groups",
      timeZone: "Asia/Kolkata",
      filter: {
        and: [
          {
            property: "p1xx",
            operator: "on_or_after",
            value: { relative: "one_week_ago" },
            part: "end",
          },
          {
            property: "p1xx",
            operator: "within",
            value: { direction: "next", unit: "week", count: 2 },
          },
        ],
      },
      scope: { group: { kind: "option", optionId: "o1aa" }, parentRowId: null },
      include: { total: true },
    };
    expect(roundTrip(SpaceDatabaseQueryInput, query)).toEqual(query);
    expect(decodes(SpaceDatabaseQueryInput, { ...query, mode: "tree" })).toBe(false);
    expect(decodes(SpaceDatabaseQueryInput, { ...query, timeZone: undefined })).toBe(false);
  });
});

describe("Spaces database mutations", () => {
  const requests = [
    {
      operation: "createDatabase",
      input: {
        ...ack,
        spaceId: "s",
        title: "T",
        properties: [{ name: "Due", type: "date" }],
        appendToPageId: "p",
      },
    },
    { operation: "updateDatabase", input: { ...ack, databaseId: "d", icon: null } },
    { operation: "createDataSource", input: { ...ack, databaseId: "d", name: "Tasks" } },
    {
      operation: "updateDataSource",
      input: { ...ack, dataSourceId: "ds", subItems: null, defaultTemplateId: null },
    },
    { operation: "deleteDataSource", input: { ...ack, dataSourceId: "ds" } },
    {
      operation: "updateSchema",
      input: {
        ...ack,
        dataSourceId: "ds",
        operations: [
          {
            op: "addProperty",
            property: { name: "Tag", type: "multi_select", options: [{ name: "a", color: "red" }] },
            beforePropertyId: null,
          },
          { op: "updateProperty", propertyId: "p1xx", description: null },
          { op: "changePropertyType", propertyId: "p1xx", type: "text" },
          { op: "moveProperty", propertyId: "p1xx", beforePropertyId: null },
          { op: "removeProperty", propertyId: "p1xx" },
          { op: "restoreProperty", propertyId: "p1xx" },
          { op: "addOption", propertyId: "p1xx", option: { name: "x", group: "todo" } },
          { op: "updateOption", propertyId: "p1xx", optionId: "o1aa", color: "blue" },
          { op: "moveOption", propertyId: "p1xx", optionId: "o1aa", beforeOptionId: null },
          { op: "removeOption", propertyId: "p1xx", optionId: "o1aa" },
        ],
      },
    },
    {
      operation: "createView",
      input: {
        ...ack,
        dataSourceId: "ds",
        name: "Board",
        type: "board",
        beforeViewId: null,
        block: { pageId: "p", blockId: "b" },
      },
    },
    {
      operation: "updateView",
      input: {
        ...ack,
        viewId: "v",
        filter: null,
        group: null,
        properties: { set: { p1xx: { width: 200, wrap: null }, p2xx: null }, order: ["p1xx"] },
      },
    },
    { operation: "deleteView", input: { ...ack, viewId: "v" } },
    {
      operation: "createRows",
      input: {
        ...ack,
        dataSourceId: "ds",
        rows: [{ title: "A", cells: { p1xx: { start: "2026-01-01" } } }],
        beforeRowId: null,
      },
    },
    {
      operation: "updateRows",
      input: {
        ...ack,
        dataSourceId: "ds",
        rows: [
          {
            pageId: "r",
            cells: {
              p1xx: null,
              p2xx: {
                start: "2026-01-01T09:00:00",
                end: "2026-01-01T10:00:00",
                timeZone: "Europe/Paris",
              },
              p3xx: ["r1", "r2"],
              p4xx: [{ name: "doc", url: "https://example.com/a" }],
            },
          },
        ],
      },
    },
    {
      operation: "moveRows",
      input: { ...ack, dataSourceId: "ds", pageIds: ["r"], beforeRowId: null },
    },
  ] as const;

  it("decodes every operation strictly and rejects unknown keys", () => {
    const decodeRequest = Schema.decodeUnknownSync(SpaceMutationRequest, {
      onExcessProperty: "error",
    });
    expect(requests.map((r) => r.operation).toSorted()).toEqual(
      [
        "createDatabase",
        "updateDatabase",
        "createDataSource",
        "updateDataSource",
        "deleteDataSource",
        "updateSchema",
        "createView",
        "updateView",
        "deleteView",
        "createRows",
        "updateRows",
        "moveRows",
      ].toSorted(),
    );
    for (const request of requests) {
      expect(decodeRequest(request)).toEqual(request);
      expect(
        () => decodeRequest({ ...request, input: { ...request.input, bogus: 1 } }),
        request.operation,
      ).toThrow();
    }
    // Mutation inputs name literal property and view types, never envelopes.
    expect(
      decodes(SpaceMutationRequest, {
        operation: "createView",
        input: { ...ack, dataSourceId: "ds", name: "V", type: "future_map" },
      }),
    ).toBe(false);
    expect(
      decodes(SpaceMutationRequest, {
        operation: "createDatabase",
        input: {
          ...ack,
          spaceId: "s",
          title: "T",
          properties: [{ name: "X", type: "future_geo" }],
        },
      }),
    ).toBe(false);
  });

  it("round-trips saved receipts that carry only ids, revisions and counts", () => {
    const receipts = [
      {
        operation: "createDatabase",
        result: {
          ...saved,
          databaseId: "d",
          dataSourceId: "ds",
          viewId: "v",
          propertyIds: ["p1xx"],
          block: { pageId: "p", blockId: "b", revision: 2 },
        },
      },
      {
        operation: "updateSchema",
        result: {
          ...saved,
          dataSourceId: "ds",
          schemaRevision: 3,
          dataRevision: 4,
          created: [
            { index: 0, propertyId: "p1xx" },
            { index: 1, optionId: "o1aa" },
          ],
          clearedCells: 0,
          affectedDataSourceIds: ["ds", "other"],
        },
      },
      {
        operation: "createRows",
        result: {
          ...saved,
          dataSourceId: "ds",
          dataRevision: 5,
          rows: [{ pageId: "r", number: 1 }],
        },
      },
      {
        operation: "updateRows",
        result: {
          ...saved,
          dataSourceId: "ds",
          dataRevision: 6,
          rows: [{ pageId: "r", revision: 2, updatedAt: "2026-01-01T00:00:00.000Z" }],
          affectedDataSourceIds: [],
        },
      },
    ];
    for (const receipt of receipts) {
      expect(roundTrip(SpaceMutationReceipt, receipt)).toEqual(receipt);
      expect(
        decodes(SpaceMutationReceipt, {
          ...receipt,
          result: { ...receipt.result, status: "conflict" },
        }),
      ).toBe(false);
    }
  });
});

describe("Spaces databases computed values", () => {
  const info = { resultType: "number", queryType: "number", inputs: ["p2xx"], volatile: false };
  const property = { id: "p1xx", name: "N", type: "formula", config: {}, position: 1 };
  it("keeps old and new property envelopes decodable in both directions", () => {
    // The pre-computed envelope, copied: an older client decodes a new property, ignoring `computed`.
    const OldProperty = Schema.StructWithRest(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        type: Schema.String,
        config: Schema.Json,
        position: Schema.Int,
      }),
      [Schema.Record(Schema.String, Schema.Json)],
    );
    const fresh = { ...property, computed: { ...info, future: { a: 1 } } };
    expect(decodes(OldProperty, fresh)).toBe(true);
    expect(decodes(SpaceDatabaseProperty, property)).toBe(true);
    expect(roundTrip(SpaceDatabaseProperty, fresh)).toEqual(fresh);
    expect(
      decodes(SpaceDatabaseProperty, {
        ...property,
        computed: { ...info, error: { message: "x" } },
      }),
    ).toBe(true);
    expect(spacePropertyQueryType(fresh as never)).toBe("number");
    expect(
      spacePropertyQueryType({ ...fresh, computed: { resultType: "text" } } as never),
    ).toBeUndefined();
    expect(spacePropertyQueryType({ ...property, type: "select" } as never)).toBe("select");
    expect(spacePropertyQueryType({ ...property, type: "future_geo" } as never)).toBeUndefined();
    expect(SPACE_FORMULA_TYPE_BY_PROPERTY.multi_select).toEqual({ list: "text" });
  });

  it("decodes the known computed value shapes and the additive result keys", () => {
    const known = [
      { type: "string", value: "a", color: "red", runs: [{ text: "a", marks: [] }] },
      { type: "number", value: 2 },
      { type: "boolean", value: true },
      { type: "date", value: { start: "2026-11-11" } },
      { type: "page", value: "pg", dataSourceId: "ds" },
      { type: "array", value: [{ type: "number", value: 1 }], truncated: true },
    ];
    for (const value of known)
      expect(decodes(SpaceKnownComputedValue, value), value.type).toBe(true);
    expect(decodes(SpaceKnownComputedValue, { type: "string", value: 1 })).toBe(false);
    const result = {
      dataSourceId: "ds",
      schemaRevision: 1,
      dataRevision: 1,
      rows: [],
      relatedPages: {},
      nextCursor: null,
    };
    expect(decodes(SpaceDatabaseQueryResult, result)).toBe(true);
    expect(decodes(SpaceDatabaseQueryResult, { ...result, computedPending: true })).toBe(true);
    expect(
      decodes(SpaceDatabaseRowGetInput, { environmentId: "env", pageId: "pg", timeZone: "UTC" }),
    ).toBe(true);
    expect(decodes(SpaceDatabaseRowGetInput, { environmentId: "env", pageId: "pg" })).toBe(true);
    const row = {
      page: {
        id: "pg",
        title: "",
        revision: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      number: 1,
      cells: {},
    };
    const got = {
      row,
      template: false,
      dataSource: { id: "ds", databaseId: "db", schemaRevision: 1, dataRevision: 1 },
      relatedPages: {},
      mutationAdmission: {
        epoch: "e",
        acceptsUntil: "2026-01-01T00:00:00.000Z",
        retainUntil: "2026-01-01T00:00:00.000Z",
      },
    };
    expect(decodes(SpaceDatabaseRowGetResult, { ...got, computedPending: true })).toBe(true);
  });

  it("carries a detail on database errors and decodes the old shape", () => {
    const error = {
      _tag: "SpaceDatabaseError",
      reason: "invalid_property_config",
      propertyId: "p1xx",
    };
    expect(decodes(SpaceDatabaseError, error)).toBe(true);
    expect(
      decodes(SpaceDatabaseError, { ...error, detail: '1:4 There is no property named "x".' }),
    ).toBe(true);
    expect(decodes(SpaceDatabaseError, { ...error, detail: "x".repeat(501) })).toBe(false);
  });

  it("accepts number display keys on formula and rollup configs", () => {
    expect(
      decodes(SpaceKnownPropertyConfig.formula, {
        expression: "1",
        format: "percent",
        decimals: 2,
      }),
    ).toBe(true);
    expect(decodes(SpaceKnownPropertyConfig.formula, { expression: "1", decimals: 11 })).toBe(
      false,
    );
    expect(
      decodes(SpaceKnownPropertyConfig.rollup, {
        relationPropertyId: "a",
        targetPropertyId: "b",
        function: "sum",
        format: "dollar",
      }),
    ).toBe(true);
  });
});
