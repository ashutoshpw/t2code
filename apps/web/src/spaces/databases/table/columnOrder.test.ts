import { expect, it } from "vite-plus/test";

import { reorderedPropertyIds } from "./columnOrder";

it("moves a visible column and leaves the title and hidden columns in their slots", () => {
  const all = [
    { id: "title", visible: true },
    { id: "a", visible: true },
    { id: "hidden", visible: false },
    { id: "b", visible: true },
    { id: "c", visible: true },
  ];
  expect(reorderedPropertyIds(all, "c", "a")).toEqual(["title", "c", "hidden", "a", "b"]);
  expect(reorderedPropertyIds(all, "a", "c")).toEqual(["title", "b", "hidden", "c", "a"]);
  expect(reorderedPropertyIds(all, "a", "a")).toEqual(all.map((column) => column.id));
});
