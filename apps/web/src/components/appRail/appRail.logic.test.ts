import { describe, expect, it } from "vite-plus/test";
import { isAppRailPath, resolveAppRailActiveItem } from "./appRail.logic";

describe("resolveAppRailActiveItem", () => {
  it("resolves chat routes to threads", () => {
    expect(resolveAppRailActiveItem("/")).toBe("threads");
    expect(resolveAppRailActiveItem("/env-1/thread-2")).toBe("threads");
    expect(resolveAppRailActiveItem("/draft/abc")).toBe("threads");
    expect(resolveAppRailActiveItem("/new")).toBe("threads");
  });

  it("resolves utility pages", () => {
    expect(resolveAppRailActiveItem("/pull-requests")).toBe("pull-requests");
    expect(resolveAppRailActiveItem("/usage")).toBe("usage");
    expect(resolveAppRailActiveItem("/scheduled-tasks")).toBe("scheduled-tasks");
    expect(resolveAppRailActiveItem("/settings")).toBe("settings");
    expect(resolveAppRailActiveItem("/settings/general")).toBe("settings");
  });

  it("does not match prefixes of other paths", () => {
    expect(resolveAppRailActiveItem("/usages")).toBe("threads");
    expect(resolveAppRailActiveItem("/settingsx")).toBe("threads");
    expect(resolveAppRailActiveItem("/scheduled-tasks-extra")).toBe("threads");
  });
});

describe("isAppRailPath", () => {
  it("matches nested paths of the same item", () => {
    expect(isAppRailPath("/settings/appearance", "settings")).toBe(true);
    expect(isAppRailPath("/pull-requests", "pull-requests")).toBe(true);
  });

  it("rejects other items", () => {
    expect(isAppRailPath("/settings/general", "usage")).toBe(false);
    expect(isAppRailPath("/usage", "scheduled-tasks")).toBe(false);
  });
});
