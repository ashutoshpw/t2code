import { describe, expect, it } from "vite-plus/test";
import { canBrowseSpaces, spacesAvailability } from "./spaces.ts";

const capability = { version: 1 };

describe("Spaces compatibility and destination access", () => {
  it("requires a supported enabled capability and read grant even with an operate grant", () => {
    const destination = { connected: true, capability, canRead: true, canOperate: false };
    expect(spacesAvailability(destination)).toBe("read-only");
    expect(spacesAvailability({ ...destination, capability: { version: 2 } })).toBe("read-only");
    expect(spacesAvailability({ ...destination, canOperate: true })).toBe("writable");
    for (const changed of [
      { ...destination, capability: undefined },

      { ...destination, capability: { ...capability, version: 99 } },
      { ...destination, canRead: false, canOperate: true },
      { ...destination, connected: false },
    ])
      expect(canBrowseSpaces(spacesAvailability(changed))).toBe(false);
  });
});
