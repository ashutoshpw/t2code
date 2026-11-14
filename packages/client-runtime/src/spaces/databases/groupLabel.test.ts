import { SpacePropertyId } from "@t2code/contracts/spaces";
import { describe, expect, it } from "vite-plus/test";

import { groupLabel } from "./groupLabel.ts";
import { knownProperty } from "./schema.ts";

const known = knownProperty({
  id: SpacePropertyId.make("state"),
  name: "State",
  type: "select",
  config: { options: [{ id: "a", name: "Alpha", color: "red" }] },
  position: 0,
});
const noHint = () => undefined;
const bucket = (key: object, label?: string) =>
  ({ key, label }) as Parameters<typeof groupLabel>[0];

describe("groupLabel", () => {
  it("colours an option bucket by its option, or by the hint for an unknown option", () => {
    expect(groupLabel(bucket({ kind: "option", optionId: "a" }), known, "State", noHint)).toEqual({
      text: "Alpha",
      color: "red",
    });
    expect(
      groupLabel(bucket({ kind: "option", optionId: "z" }), known, "State", () => ({
        name: "Zed",
        color: "blue",
      })),
    ).toEqual({ text: "Zed", color: "blue" });
  });

  it("colours the status groups and leaves unknown ones plain", () => {
    const colors = ["todo", "in_progress", "complete", "other"].map(
      (group) => groupLabel(bucket({ kind: "status_group", group }), null, "S", noHint).color,
    );
    expect(colors).toEqual(["gray", "blue", "green", undefined]);
  });

  it("gives the empty bucket no colour", () => {
    expect(groupLabel(bucket({ kind: "empty" }), null, "State", noHint)).toEqual({
      text: "No State",
    });
  });
});
