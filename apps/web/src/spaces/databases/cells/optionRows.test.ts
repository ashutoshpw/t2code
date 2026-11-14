import type { SpaceKnownDatabaseProperty } from "@t2code/contracts/spaces";
import { describe, expect, it } from "vite-plus/test";

import { optionRows, selectedOptions, type OptionKnown } from "./optionRows";

const select = {
  id: "stage",
  name: "Stage",
  type: "select",
  config: {
    options: [
      { id: "a", name: "Alpha", color: "blue" },
      { id: "b", name: "Beta", color: "red" },
    ],
  },
} as unknown as OptionKnown;
const status = {
  id: "st",
  name: "Status",
  type: "status",
  config: {
    options: [
      { id: "t", name: "Not started", color: "gray", group: "todo" },
      { id: "d", name: "Done", color: "green", group: "complete" },
    ],
  },
} as unknown as SpaceKnownDatabaseProperty as OptionKnown;
const on = { canCreate: true, createGroup: "todo" } as const;

describe("optionRows", () => {
  it("filters case-insensitively and offers create for a new name", () => {
    expect(optionRows(select, " AL ", on)).toEqual([
      { kind: "option", option: select.config.options[0] },
      { kind: "create", name: "AL" },
    ]);
  });

  it("withholds create for an empty query, an exact match in other case, or no permission", () => {
    expect(optionRows(select, "", on).some((row) => row.kind === "create")).toBe(false);
    expect(optionRows(select, "alpha", on).some((row) => row.kind === "create")).toBe(false);
    expect(
      optionRows(select, "Zed", { ...on, canCreate: false }).some((row) => row.kind === "create"),
    ).toBe(false);
  });

  it("puts a status create in the chosen group with its heading even without a match", () => {
    expect(optionRows(status, "Zed", { canCreate: true, createGroup: "in_progress" })).toEqual([
      { kind: "heading", group: "in_progress", label: "In progress" },
      { kind: "create", name: "Zed", group: "in_progress" },
    ]);
    expect(optionRows(status, "", on).map((row) => row.kind)).toEqual([
      "heading",
      "option",
      "heading",
      "option",
    ]);
  });
});

describe("selectedOptions", () => {
  it("keeps value order and skips unknown ids", () => {
    expect(selectedOptions(select, ["b", "gone", "a"]).map((o) => o.id)).toEqual(["b", "a"]);
    expect(selectedOptions(select, "a").map((o) => o.id)).toEqual(["a"]);
    expect(selectedOptions(select, undefined)).toEqual([]);
  });
});
