import { describe, expect, it } from "vite-plus/test";

import { BACKGROUND_REFRESH_MS, backgroundPolicy } from "./backgroundPolicy";
import { databaseLimitsOf } from "./capability";

describe("backgroundPolicy", () => {
  it("refreshes only after a long absence", () => {
    expect(backgroundPolicy(null, 100_000)).toBe("none");
    expect(backgroundPolicy(0, BACKGROUND_REFRESH_MS - 1)).toBe("none");
    expect(backgroundPolicy(0, BACKGROUND_REFRESH_MS)).toBe("refresh");
  });
});

describe("databaseLimitsOf", () => {
  const limits = { maxQueryRows: 100 } as never;
  const capability = (version: number, databases: true | undefined, withLimits = true) =>
    ({
      version,
      limits: withLimits ? { databases: limits } : {},
      ...(databases ? { features: { databases } } : {}),
    }) as never;

  it("needs version 2, the databases feature and its limits", () => {
    expect(databaseLimitsOf(capability(2, true))).toBe(limits);
    expect(databaseLimitsOf(capability(1, true))).toBeNull();
    expect(databaseLimitsOf(capability(2, undefined))).toBeNull();
    expect(databaseLimitsOf(capability(2, true, false))).toBeNull();
    expect(databaseLimitsOf(undefined)).toBeNull();
  });
});
