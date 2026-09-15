import { describe, expect, it } from "vite-plus/test";

import { cliArchiveFileName, cliArchivePlatformKey, cliArchiveStem } from "./build-cli-archive.ts";

describe("build-cli-archive naming", () => {
  it("uses the canonical public archive prefix", () => {
    expect(cliArchivePlatformKey("linux", "x64")).toBe("linux-x64");
    expect(cliArchiveStem("1.2.3", "linux", "x64")).toBe("t2-1.2.3-linux-x64");
    expect(cliArchiveFileName("1.2.3", "win", "arm64")).toBe("t2-1.2.3-win32-arm64.zip");
  });

  it("does not claim an unsupported macOS x64 release archive", () => {
    expect(cliArchivePlatformKey("mac", "x64")).toBeUndefined();
    expect(cliArchiveStem("1.2.3", "mac", "x64")).toBeUndefined();
    expect(cliArchiveFileName("1.2.3", "mac", "x64")).toBeUndefined();
  });
});
