import { describe, expect, it } from "vite-plus/test";

import { dataSource, property, row, view } from "./databaseFixtures.test-support";
import {
  BOARD_ROWS_PER_GROUP,
  DESKTOP_LIMIT_NOTE,
  MAX_SECTION_ROWS,
  MAX_VIEW_ROWS,
  PICK_DATE_MESSAGE,
  UNSUPPORTED_VIEW_MESSAGE,
  canLoadMore,
  formQueryInput,
  listItems,
  previewItems,
  viewForm,
  viewSummary,
} from "./viewForms";

const options = [
  { id: "todo1", name: "Todo", color: "red", group: "todo" },
  { id: "done1", name: "Done", color: "green", group: "complete" },
];
const source = dataSource([
  property("title", "Name", "title"),
  property("status", "Status", "status", { options }),
  property("points", "Points", "number", { format: "number" }),
  property("note", "Note", "text"),
  property("due", "Due", "date"),
  property("end", "End", "date"),
  property("tags", "Tags", "multi_select", { options }),
  property("size", "Size", "number", { format: "number" }),
  property("calc", "Calc", "formula", {}, { computed: { resultType: "number" } }),
]);
const limits = { maxQueryRows: 100 };
const environmentId = "env" as never;
const queryOf = (
  form: ReturnType<typeof viewForm>,
  saved: ReturnType<typeof view>,
  month?: string,
) => formQueryInput(form, saved, { environmentId, timeZone: "UTC", ...(month ? { month } : {}) });
const hint = () => undefined;

describe("viewForm", () => {
  it("draws a table as cards with at most four properties and asks only for them", () => {
    const saved = view("table", {
      visible: ["status", "points", "note", "due", "end", "tags"],
      layout: { loadLimit: 100 },
    });
    const form = viewForm(saved, source, limits);
    expect(form).toMatchObject({ kind: "cards", mode: "rows", limit: 50 });
    expect(form.columns.map((column) => column.property.id)).toEqual([
      "status",
      "points",
      "note",
      "due",
    ]);
    const input = queryOf(form, saved)!;
    expect(input.properties).toEqual(["due", "note", "points", "status", "title"]);
    expect(input.limit).toBe(50);
  });

  it("applies the saved filter, sorts and group as they are saved, and drops the sub-group", () => {
    const filter = { property: "points", operator: "greater_than", value: 2 };
    const sorts = [{ property: "points", direction: "descending" }];
    const saved = view("list", {
      visible: ["points"],
      filter,
      sorts,
      group: { property: "status", sort: "manual" },
      subGroup: { property: "tags" },
    });
    const form = viewForm(saved, source, limits);
    expect(form).toMatchObject({
      kind: "compact",
      mode: "groups",
      rowsPerGroup: BOARD_ROWS_PER_GROUP,
    });
    const input = queryOf(form, saved)!;
    expect(input).toMatchObject({
      filter,
      sorts,
      group: saved.group,
      subGroup: null,
      mode: "groups",
    });
    expect(input.properties).toContain("status");
    expect(input.limit).toBe(25);
  });

  it("limits a list to two properties and caps the window by the server's limit", () => {
    const saved = view("list", {
      visible: ["status", "points", "note"],
      layout: { loadLimit: 25 },
    });
    const form = viewForm(saved, source, { maxQueryRows: 10 });
    expect(form.columns).toHaveLength(2);
    expect(form.limit).toBe(10);
  });

  it("draws a board by its group, without the grouped property on the cards, and an ungrouped board as a table", () => {
    const saved = view("board", {
      visible: ["status", "points", "note", "due", "end"],
      group: { property: "status" },
    });
    const form = viewForm(saved, source, limits);
    expect(form.kind).toBe("board");
    expect(form.columns.map((column) => column.property.id)).toEqual(["points", "note", "due"]);
    expect(viewForm(view("board", { visible: ["points"] }), source, limits)).toMatchObject({
      kind: "cards",
      mode: "rows",
    });
  });

  it("tints a board only when its layout asks for colored columns", () => {
    const group = { property: "status" };
    const tinted = (type: string, layout: Record<string, unknown>) =>
      viewForm(view(type, { group, layout }), source, limits).tint;
    expect(tinted("board", { colorColumns: true })).toBe(true);
    expect(tinted("board", {})).toBe(false);
    expect(tinted("table", { colorColumns: true })).toBe(false);
  });

  it("treats a group on a property that is gone as no group", () => {
    const saved = view("table", { group: { property: "missing" } });
    expect(viewForm(saved, source, limits)).toMatchObject({ mode: "rows", group: undefined });
  });

  it("notes that covers are shown on desktop, and leads a gallery card with its preview property", () => {
    expect(
      viewForm(view("gallery", { layout: { cardPreview: { kind: "page_cover" } } }), source, limits)
        .notes,
    ).toEqual(["Cover images are shown on desktop."]);
    const form = viewForm(
      view("gallery", {
        visible: ["points", "note"],
        layout: { cardPreview: { kind: "property", propertyId: "note" } },
      }),
      source,
      limits,
    );
    expect(form.previewColumn?.property.id).toBe("note");
    expect(form.columns.map((column) => column.property.id)).toEqual(["points"]);
    expect(form.notes).toEqual([]);
  });

  it("runs a calendar for one month over the date property and returns no query without one", () => {
    const saved = view("calendar", { visible: ["points"], layout: { datePropertyId: "due" } });
    const form = viewForm(saved, source, limits);
    expect(form).toMatchObject({ kind: "agenda", mode: "rows", limit: 100 });
    expect(form.notes).toEqual(["Rows without a date are listed on desktop."]);
    const input = queryOf(form, saved, "2026-11-01")!;
    expect(input.extraFilter).toEqual({
      and: [
        { property: "due", operator: "on_or_before", value: "2026-11-30", part: "start" },
        { property: "due", operator: "on_or_after", value: "2026-11-01", part: "end" },
      ],
    });
    expect(input.properties).toContain("due");
    expect(input.group).toBeNull();
    for (const layout of [{ datePropertyId: "note" }, { datePropertyId: "gone" }, {}]) {
      const broken = viewForm(view("calendar", { layout }), source, limits);
      expect(broken).toMatchObject({ kind: "message", mode: null, message: PICK_DATE_MESSAGE });
      expect(queryOf(broken, view("calendar", { layout }))).toBeNull();
    }
  });

  it("accepts a formula that results in a date and uses an end property for a timeline", () => {
    const withFormula = dataSource([
      property("title", "Name", "title"),
      property(
        "when",
        "When",
        "formula",
        {},
        { computed: { resultType: "date", queryType: "date" } },
      ),
      property("end", "End", "date"),
    ]);
    expect(
      viewForm(view("calendar", { layout: { datePropertyId: "when" } }), withFormula, limits).kind,
    ).toBe("agenda");
    const saved = view("timeline", { layout: { startPropertyId: "when", endPropertyId: "end" } });
    const input = queryOf(viewForm(saved, withFormula, limits), saved, "2026-11-01")!;
    expect(input.extraFilter).toEqual({
      and: [
        { property: "when", operator: "on_or_before", value: "2026-11-30", part: "start" },
        { property: "end", operator: "on_or_after", value: "2026-11-01", part: "end" },
      ],
    });
    expect(input.properties).toEqual(expect.arrayContaining(["when", "end"]));
  });

  it("shows a neutral message for a view type it does not know", () => {
    const form = viewForm(view("kanban2"), source, limits);
    expect(form).toMatchObject({ kind: "message", mode: null, message: UNSUPPORTED_VIEW_MESSAGE });
    expect(
      listItems(form, {
        dataSourceId: "s",
        rows: [],
        groups: null,
        hasMore: false,
        optionHint: hint,
        zone: "UTC",
      }),
    ).toEqual([]);
  });
});

describe("viewSummary", () => {
  it("names what the saved view does and where to change it", () => {
    expect(viewSummary(view("table"), source)).toBe(
      "Change filters, sorting and layout on desktop.",
    );
    expect(
      viewSummary(
        view("table", {
          filter: { property: "points", operator: "is_empty" },
          sorts: [{ property: "points", direction: "ascending" }],
          group: { property: "status" },
        }),
        source,
      ),
    ).toBe("Filtered · Sorted · Grouped by Status. Change views on desktop.");
  });
});

describe("listItems", () => {
  const rows = (count: number, prefix = "r") =>
    Array.from({ length: count }, (_, index) => row(`${prefix}${index}`, `Row ${index}`));
  const base = { dataSourceId: "source1", optionHint: hint, zone: "UTC" } as const;

  it("lists rows with stable keys and stops offering more at the row cap", () => {
    const form = viewForm(view("table"), source, limits);
    const items = listItems(form, {
      ...base,
      rows: rows(MAX_VIEW_ROWS),
      groups: null,
      hasMore: true,
    });
    expect(items[0]).toMatchObject({ kind: "row", key: "source1:r0" });
    expect(items.at(-1)).toEqual({ kind: "note", key: "note:desktop", text: DESKTOP_LIMIT_NOTE });
    expect(new Set(items.map((item) => item.key)).size).toBe(items.length);
    expect(canLoadMore(MAX_VIEW_ROWS - 1, true)).toBe(true);
    expect(canLoadMore(MAX_VIEW_ROWS, true)).toBe(false);
    expect(canLoadMore(10, false)).toBe(false);
  });

  it("makes a board section per column in group order, leaves hidden ones out and offers more per section", () => {
    const saved = view("board", {
      group: {
        property: "status",
        sort: "manual",
        order: [
          { kind: "option", optionId: "done1" },
          { kind: "option", optionId: "todo1" },
        ],
        hidden: [{ kind: "empty" }],
      },
    });
    const form = viewForm(saved, source, limits);
    const buckets = [
      { key: { kind: "empty" }, count: 1, rows: rows(1, "e"), nextCursor: null },
      {
        key: { kind: "option", optionId: "todo1" },
        count: 40,
        rows: rows(10, "t"),
        nextCursor: "c1",
      },
      { key: { kind: "option", optionId: "done1" }, count: 0, rows: [], nextCursor: null },
    ];
    const items = listItems(form, {
      ...base,
      rows: [],
      groups: buckets as never,
      hasMore: false,
      bucketLoading: (key) => key.kind === "option",
    });
    const headers = items.filter((item) => item.kind === "header");
    expect(headers.map((item) => (item.kind === "header" ? item.label.text : ""))).toEqual([
      "Done",
      "Todo",
    ]);
    expect(headers[0]).toMatchObject({ count: 0, label: { color: "green" } });
    const more = items.find((item) => item.kind === "more");
    expect(more).toMatchObject({
      text: "Show more in Todo",
      loading: true,
      bucket: { kind: "option" },
    });
    expect(new Set(items.map((item) => item.key)).size).toBe(items.length);
  });

  it("gives a tinted section its color on header and rows and closes it on its last item", () => {
    const saved = view("board", { group: { property: "status" }, layout: { colorColumns: true } });
    const form = viewForm(saved, source, limits);
    const items = listItems(form, {
      ...base,
      rows: [],
      groups: [
        {
          key: { kind: "option", optionId: "todo1" },
          count: 2,
          rows: rows(2, "t"),
          nextCursor: null,
        },
        { key: { kind: "empty" }, count: 1, rows: rows(1, "e"), nextCursor: null },
      ] as never,
      hasMore: false,
    });
    expect(items.map((item) => ("tint" in item ? item.tint : undefined))).toEqual([
      undefined,
      undefined,
      "red",
      "red",
      "red",
    ]);
    expect(items.map((item) => ("last" in item ? item.last : undefined))).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    ]);
  });

  it("drops empty sections outside a board and caps a section with a note", () => {
    const form = viewForm(view("table", { group: { property: "status" } }), source, limits);
    const items = listItems(form, {
      ...base,
      rows: [],
      groups: [
        { key: { kind: "option", optionId: "done1" }, count: 0, rows: [], nextCursor: null },
        {
          key: { kind: "option", optionId: "todo1" },
          count: 900,
          rows: rows(MAX_SECTION_ROWS),
          nextCursor: "c",
        },
      ] as never,
      hasMore: false,
    });
    expect(items.filter((item) => item.kind === "header")).toHaveLength(1);
    expect(items.at(-1)).toMatchObject({ kind: "note", text: DESKTOP_LIMIT_NOTE });
    expect(items.some((item) => item.kind === "more")).toBe(false);
  });

  it("keeps the same row distinct in two buckets of a multi-select group", () => {
    const form = viewForm(view("list", { group: { property: "tags" } }), source, limits);
    const shared = row("shared", "Shared");
    const items = listItems(form, {
      ...base,
      rows: [],
      groups: [
        { key: { kind: "option", optionId: "todo1" }, count: 1, rows: [shared], nextCursor: null },
        { key: { kind: "option", optionId: "done1" }, count: 1, rows: [shared], nextCursor: null },
      ] as never,
      hasMore: false,
    });
    const keys = items.map((item) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("lists an agenda by day and offers more while the month has more rows", () => {
    const saved = view("calendar", { layout: { datePropertyId: "due" } });
    const form = viewForm(saved, source, limits);
    const items = listItems(form, {
      ...base,
      rows: [
        row("a", "A", { due: { start: "2026-11-05" } }),
        row("b", "B", { due: { start: "2026-10-30", end: "2026-11-02" } }),
      ],
      groups: null,
      hasMore: true,
      month: "2026-11-01",
    });
    expect(items.map((item) => item.kind)).toEqual(["header", "row", "header", "row", "more"]);
    expect(items[1]).toMatchObject({ span: "Fri, Oct 30 → Mon, Nov 2" });
    expect(items.at(-1)).toMatchObject({ kind: "more", bucket: null });
  });

  it("stops offering more on an agenda at the row cap", () => {
    const form = viewForm(view("calendar", { layout: { datePropertyId: "due" } }), source, limits);
    const agenda = (count: number) =>
      listItems(form, {
        ...base,
        rows: Array.from({ length: count }, (_, index) =>
          row(`a${index}`, `A ${index}`, { due: { start: "2026-11-05" } }),
        ),
        groups: null,
        hasMore: true,
        month: "2026-11-01",
      }).at(-1);
    expect(agenda(MAX_VIEW_ROWS - 1)).toMatchObject({ kind: "more", bucket: null });
    expect(agenda(MAX_VIEW_ROWS)).toEqual({
      kind: "note",
      key: "note:desktop",
      text: DESKTOP_LIMIT_NOTE,
    });
  });

  it("cuts a preview to the first rows with their headers and without more or notes", () => {
    const form = viewForm(view("table", { group: { property: "status" } }), source, limits);
    const items = listItems(form, {
      ...base,
      rows: [],
      groups: [
        {
          key: { kind: "option", optionId: "todo1" },
          count: 3,
          rows: rows(3, "t"),
          nextCursor: "c",
        },
        {
          key: { kind: "option", optionId: "done1" },
          count: 1,
          rows: rows(1, "d"),
          nextCursor: null,
        },
      ] as never,
      hasMore: false,
    });
    const preview = previewItems(items, 3);
    expect(preview.map((item) => item.kind)).toEqual(["header", "row", "row", "row"]);
    expect(previewItems(items, 0)).toEqual([]);
  });
});
