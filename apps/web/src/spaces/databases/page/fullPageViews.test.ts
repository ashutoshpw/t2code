import type { SpaceDatabaseView, SpaceViewId } from "@t2code/contracts/spaces";
import { describe, expect, it } from "vite-plus/test";

import { fullPageViewIds } from "./fullPageViews";

const id = (value: string) => value as SpaceViewId;
const views = ["a", "b", "c"].map(
  (value) => ({ id: id(value), ownerBlockId: value === "a" ? "h" : "other" }) as SpaceDatabaseView,
);

describe("fullPageViewIds", () => {
  it.each([
    { name: "requested already listed", home: ["a", "b"], requested: "b", expected: ["a", "b"] },
    { name: "requested unknown", home: ["a"], requested: "zzz", expected: ["a"] },
    { name: "requested from another block", home: ["a"], requested: "c", expected: ["a", "c"] },
    { name: "old server: owned views", home: undefined, requested: undefined, expected: ["a"] },
    { name: "requested with no home ids", home: undefined, requested: "c", expected: ["a", "c"] },
  ])("$name", ({ home, requested, expected }) => {
    expect(fullPageViewIds({ blockId: "h", viewIds: home?.map(id) }, requested, views)).toEqual(
      expected,
    );
  });
});
