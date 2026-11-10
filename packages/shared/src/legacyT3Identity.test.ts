// @effect-diagnostics nodeBuiltinImport:off - tests stage a fake home directory on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

import {
  applyLegacyEnv,
  copyLegacyHome,
  hasExplicitHomeEnv,
  legacyEnvDeprecationMessage,
  legacyEnvProvider,
} from "./legacyT3Identity.ts";

const withHome = (run: (home: string) => void) => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t2-legacy-home-"));
  try {
    run(home);
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
};

const seedLegacy = (home: string) => {
  const userdata = NodePath.join(home, ".t3", "userdata");
  NodeFS.mkdirSync(userdata, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(userdata, "statev2.sqlite"), "db");
  NodeFS.writeFileSync(NodePath.join(userdata, "server-runtime.json"), "{}");
  NodeFS.mkdirSync(NodePath.join(home, ".t3", "worktrees", "w"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(home, ".t3", "worktrees", "w", "f"), "x");
};

describe("copyLegacyHome", () => {
  it("copies the legacy home without touching it and skips worktrees and runtime state", () =>
    withHome((home) => {
      seedLegacy(home);
      const result = copyLegacyHome({ homeDirectory: home });
      expect(result._tag).toBe("copied");
      expect(NodeFS.readFileSync(NodePath.join(home, ".t2/userdata/statev2.sqlite"), "utf8")).toBe(
        "db",
      );
      expect(NodeFS.existsSync(NodePath.join(home, ".t2/userdata/server-runtime.json"))).toBe(
        false,
      );
      expect(NodeFS.existsSync(NodePath.join(home, ".t2/worktrees"))).toBe(false);
      expect(NodeFS.existsSync(NodePath.join(home, ".t3/userdata/server-runtime.json"))).toBe(true);
      expect(NodeFS.existsSync(NodePath.join(home, ".t3/worktrees/w/f"))).toBe(true);
      expect(NodeFS.readdirSync(home).sort()).toEqual([".t2", ".t3"]);
    }));

  it("skips when the T2 home exists or no legacy home does", () =>
    withHome((home) => {
      expect(copyLegacyHome({ homeDirectory: home })._tag).toBe("skipped");
      seedLegacy(home);
      NodeFS.mkdirSync(NodePath.join(home, ".t2"));
      expect(copyLegacyHome({ homeDirectory: home })._tag).toBe("skipped");
      expect(NodeFS.readdirSync(NodePath.join(home, ".t2"))).toEqual([]);
    }));

  it("refuses a legacy home above the size limit and leaves both sides alone", () =>
    withHome((home) => {
      seedLegacy(home);
      const result = copyLegacyHome({ homeDirectory: home, maxBytes: 1 });
      expect(result._tag).toBe("tooLarge");
      expect(NodeFS.existsSync(NodePath.join(home, ".t2"))).toBe(false);
    }));
});

describe("legacy env fallback", () => {
  it("treats either home variable as an explicit home", () => {
    expect(hasExplicitHomeEnv({ T3CODE_HOME: "/data/t3" })).toBe(true);
    expect(hasExplicitHomeEnv({ T2CODE_HOME: "/data/t2" })).toBe(true);
    expect(hasExplicitHomeEnv({ T3CODE_HOME: "  " })).toBe(false);
    expect(hasExplicitHomeEnv({})).toBe(false);
  });

  it("fills unset T2CODE names from T3CODE and lets T2CODE win", () => {
    const { env, usedLegacyNames } = applyLegacyEnv({
      T3CODE_PORT: "1",
      T3CODE_HOST: "legacy",
      T2CODE_HOST: "current",
      OTHER: "x",
    });
    expect(env.T2CODE_PORT).toBe("1");
    expect(env.T2CODE_HOST).toBe("current");
    expect(usedLegacyNames).toEqual(["T3CODE_PORT"]);
    expect(legacyEnvDeprecationMessage(usedLegacyNames)).toContain("T3CODE_PORT -> T2CODE_PORT");
  });

  it.effect("serves the fallback through the config provider", () =>
    Effect.gen(function* () {
      const { provider } = legacyEnvProvider({ T3CODE_HOME: "/legacy" });
      const node = yield* provider.load(["T2CODE_HOME"]);
      expect(node).toEqual(
        yield* ConfigProvider.fromEnv({ env: { T2CODE_HOME: "/legacy" } }).load(["T2CODE_HOME"]),
      );
    }),
  );
});
