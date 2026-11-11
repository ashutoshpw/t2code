import { knownProperty } from "@t2code/client-runtime/spaces";
import { SPACE_GROUPABLE_TYPES, type SpaceDatabaseProperty } from "@t2code/contracts/spaces";
import { describe, expect, it } from "vite-plus/test";

import { defaultGroupBy, groupByChoices, listedBuckets } from "./groupOptions";

const property = (type: string, config: unknown = {}) =>
  knownProperty({
    id: "p",
    name: "p",
    type,
    config,
    position: 0,
  } as unknown as SpaceDatabaseProperty)!;

describe("group options", () => {
  it("starts every groupable type with a grouping the server accepts", () => {
    for (const type of SPACE_GROUPABLE_TYPES) {
      const by = defaultGroupBy(type);
      const choices = groupByChoices(type);
      if (choices.length > 0) expect(choices.map((choice) => choice.by)).toContain(by);
      expect(by, type).toBeDefined();
    }
    expect(defaultGroupBy("files")).toBeUndefined();
  });

  it("lists every bucket of option, status group and checkbox groupings", () => {
    const status = property("status", {
      options: [{ id: "a", name: "A", color: "gray", group: "todo" }],
    });
    expect(listedBuckets(status, "option")?.map((bucket) => bucket.key)).toEqual([
      { kind: "option", optionId: "a" },
      { kind: "empty" },
    ]);
    expect(listedBuckets(status, "status_group")).toHaveLength(4);
    expect(listedBuckets(property("checkbox"), "checkbox")).toHaveLength(3);
    expect(listedBuckets(property("text"), "exact")).toBeNull();
  });
});
