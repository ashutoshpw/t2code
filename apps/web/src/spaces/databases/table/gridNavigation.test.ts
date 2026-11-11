import { describe, expect, it } from "vite-plus/test";

import { nextCell } from "./gridNavigation";

const bounds = {
  rowIds: ["r1", "r2", "r3", "r4", "r5"],
  columnIds: ["title", "a", "b"],
  pageRows: 2,
};
const at = (rowId: string, columnId: string) => ({ rowId, columnId });

describe("nextCell", () => {
  it("moves one cell with the arrow keys and stops at the edges", () => {
    expect(nextCell(at("r2", "a"), { key: "ArrowUp" }, bounds)).toEqual(at("r1", "a"));
    expect(nextCell(at("r2", "a"), { key: "ArrowDown" }, bounds)).toEqual(at("r3", "a"));
    expect(nextCell(at("r2", "a"), { key: "ArrowLeft" }, bounds)).toEqual(at("r2", "title"));
    expect(nextCell(at("r2", "a"), { key: "ArrowRight" }, bounds)).toEqual(at("r2", "b"));
    expect(nextCell(at("r1", "title"), { key: "ArrowUp" }, bounds)).toBeNull();
    expect(nextCell(at("r1", "title"), { key: "ArrowLeft" }, bounds)).toBeNull();
    expect(nextCell(at("r5", "b"), { key: "ArrowDown" }, bounds)).toBeNull();
    expect(nextCell(at("r5", "b"), { key: "ArrowRight" }, bounds)).toBeNull();
  });

  it("wraps Tab and Shift+Tab to the next and previous row", () => {
    expect(nextCell(at("r1", "b"), { key: "Tab" }, bounds)).toEqual(at("r2", "title"));
    expect(nextCell(at("r2", "title"), { key: "Tab", shift: true }, bounds)).toEqual(at("r1", "b"));
    expect(nextCell(at("r5", "b"), { key: "Tab" }, bounds)).toBeNull();
    expect(nextCell(at("r1", "title"), { key: "Tab", shift: true }, bounds)).toBeNull();
  });

  it("jumps with Home, End and their Mod variants", () => {
    expect(nextCell(at("r3", "b"), { key: "Home" }, bounds)).toEqual(at("r3", "title"));
    expect(nextCell(at("r3", "a"), { key: "End" }, bounds)).toEqual(at("r3", "b"));
    expect(nextCell(at("r3", "a"), { key: "Home", mod: true }, bounds)).toEqual(at("r1", "title"));
    expect(nextCell(at("r3", "a"), { key: "End", mod: true }, bounds)).toEqual(at("r5", "b"));
  });

  it("pages by a viewport and clamps", () => {
    expect(nextCell(at("r1", "a"), { key: "PageDown" }, bounds)).toEqual(at("r3", "a"));
    expect(nextCell(at("r4", "a"), { key: "PageDown" }, bounds)).toEqual(at("r5", "a"));
    expect(nextCell(at("r3", "a"), { key: "PageUp" }, bounds)).toEqual(at("r1", "a"));
  });

  it("returns null for other keys and unknown positions", () => {
    expect(nextCell(at("r1", "a"), { key: "x" }, bounds)).toBeNull();
    expect(nextCell(at("gone", "a"), { key: "ArrowDown" }, bounds)).toBeNull();
  });
});
