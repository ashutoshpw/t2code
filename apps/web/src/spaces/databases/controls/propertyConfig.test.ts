import { knownProperty } from "@t2code/client-runtime/spaces";
import type { SpaceDatabaseProperty, SpacePropertyId } from "@t2code/contracts/spaces";
import { describe, expect, it } from "vite-plus/test";

import {
  beforeIdAfterMove,
  movedId,
  nextConfig,
  orderWithInserted,
  typeChangeNeedsConfirmation,
  uniqueName,
} from "./propertyConfig";

const id = (value: string) => value as SpacePropertyId;

describe("property config helpers", () => {
  it("only text-like to text-like changes apply without a warning", () => {
    expect(typeChangeNeedsConfirmation("text", "url")).toBe(false);
    expect(typeChangeNeedsConfirmation("email", "phone")).toBe(false);
    expect(typeChangeNeedsConfirmation("text", "number")).toBe(true);
    expect(typeChangeNeedsConfirmation("select", "text")).toBe(true);
  });

  it("builds a whole config without options and without unset keys", () => {
    const status = knownProperty({
      id: "s",
      name: "s",
      type: "status",
      position: 0,
      config: {
        options: [{ id: "a", name: "A", color: "gray", group: "todo" }],
        defaultOptionId: "a",
      },
    } as unknown as SpaceDatabaseProperty)!;
    expect(nextConfig(status, { defaultOptionId: "b" })).toEqual({ defaultOptionId: "b" });
    expect(nextConfig(status, { defaultOptionId: undefined })).toEqual({});
  });

  it("makes names unique with a numeric suffix", () => {
    expect(uniqueName("Property", ["Name"])).toBe("Property");
    expect(uniqueName("Property", ["property", "Property 2"])).toBe("Property 3");
  });

  it("inserts into the column order before a column or last", () => {
    const order = [id("a"), id("b"), id("c")];
    expect(orderWithInserted(order, id("n"), id("b"))).toEqual(["a", "n", "b", "c"]);
    expect(orderWithInserted(order, id("n"), null)).toEqual(["a", "b", "c", "n"]);
    expect(orderWithInserted(order, id("n"), id("missing"))).toEqual(["a", "b", "c", "n"]);
  });

  it("finds the moved item and what it now precedes", () => {
    expect(movedId(["a", "b", "c"], ["b", "a", "c"])).toBe("b");
    expect(movedId(["a", "b", "c"], ["a", "c", "b"])).toBe("c");
    expect(movedId(["a", "b", "c"], ["c", "a", "b"])).toBe("c");
    expect(movedId(["a", "b"], ["a", "b"])).toBeNull();
    expect(beforeIdAfterMove(["b", "a", "c"], "b")).toBe("a");
    expect(beforeIdAfterMove(["a", "c", "b"], "b")).toBeNull();
  });
});
