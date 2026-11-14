import { SPACE_VIEW_TYPES } from "@t2code/contracts/spaces";
import { describe, expect, it } from "vite-plus/test";

import { viewTraits } from "./viewTraits.ts";

describe("viewTraits", () => {
  it("keeps what the six original types offered", () => {
    for (const type of ["table", "board", "list", "gallery", "calendar", "timeline"]) {
      const traits = viewTraits(type);
      expect([traits.filter, traits.sort, traits.search, traits.newRow]).toEqual([
        true,
        true,
        true,
        true,
      ]);
      expect(traits.group).toBe("group");
      expect(traits.subItems).toBe(type === "table" || type === "list");
      expect(traits.loadLimit).toBe(type !== "calendar" && type !== "timeline");
    }
  });

  it("gives chart an x axis and form nothing editable", () => {
    expect(viewTraits("chart")).toMatchObject({ group: "x_axis", sort: false, newRow: false });
    const form = viewTraits("form");
    expect(Object.values(form).filter((value) => value === true)).toEqual([]);
    expect(viewTraits("feed")).toMatchObject({ group: null, loadLimit: true, filter: true });
  });

  it("treats an unknown type as read-only", () => {
    expect(viewTraits("hologram")).toMatchObject({ filter: false, sort: false, group: null });
    expect(viewTraits(undefined).newRow).toBe(false);
    for (const type of SPACE_VIEW_TYPES) expect(viewTraits(type)).not.toBe(viewTraits("hologram"));
  });
});
