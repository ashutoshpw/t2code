import { describe, expect, it } from "vite-plus/test";

import { envWithLegacyFallback, legacyEnvName } from "./legacyEnv.ts";

describe("legacyEnv", () => {
  it("maps T2 names to their legacy T3 names", () => {
    expect(legacyEnvName("T2CODE_HOME")).toBe("T3CODE_HOME");
    expect(legacyEnvName("T2CODE_RELEASE_BASE_URL")).toBe("T3CODE_RELEASE_BASE_URL");
  });

  it("reports no legacy name for internal-only variables", () => {
    expect(legacyEnvName("T2CODE_PORT")).toBeUndefined();
    expect(legacyEnvName("T2CODE_MODE")).toBeUndefined();
    expect(legacyEnvName("T2_UNRELATED")).toBeUndefined();
  });

  it("prefers the T2 name without warning", () => {
    const errors: string[] = [];
    const consoleError = console.error;
    console.error = (message: string) => errors.push(message);
    try {
      expect(envWithLegacyFallback({ T2CODE_HOME: "/t2", T3CODE_HOME: "/t3" }, "T2CODE_HOME")).toBe(
        "/t2",
      );
      expect(errors).toEqual([]);
    } finally {
      console.error = consoleError;
    }
  });

  it("falls back to the legacy name once per process", () => {
    const errors: string[] = [];
    const consoleError = console.error;
    console.error = (message: string) => errors.push(message);
    try {
      const env = { T3CODE_HOME: "/t3" };
      expect(envWithLegacyFallback(env, "T2CODE_HOME")).toBe("/t3");
      expect(envWithLegacyFallback(env, "T2CODE_HOME")).toBe("/t3");
      expect(errors).toEqual(["[t2code] T3CODE_HOME is deprecated; set T2CODE_HOME instead."]);
    } finally {
      console.error = consoleError;
    }
  });

  it("treats an empty legacy value as set", () => {
    const errors: string[] = [];
    const consoleError = console.error;
    console.error = (message: string) => errors.push(message);
    try {
      expect(envWithLegacyFallback({ T3CODE_HOME: "" }, "T2CODE_HOME")).toBe("");
      expect(errors).toEqual([]);
    } finally {
      console.error = consoleError;
    }
  });

  it("returns undefined when neither name is set", () => {
    expect(envWithLegacyFallback({}, "T2CODE_HOME")).toBeUndefined();
    expect(envWithLegacyFallback({ T2CODE_PORT: "1" }, "T2CODE_PORT")).toBe("1");
  });
});
