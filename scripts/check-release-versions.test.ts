import { describe, expect, it } from "vite-plus/test";

import { findVersionMismatches, readReleaseVersions } from "./check-release-versions.ts";

describe("check-release-versions", () => {
  it("reports every package that differs from the first", () => {
    expect(
      findVersionMismatches([
        { file: "a", version: "0.1.5" },
        { file: "b", version: "0.1.7" },
        { file: "c", version: "0.1.5" },
        { file: "d", version: undefined },
      ]),
    ).toEqual(["b: 0.1.7", "d: undefined"]);
  });

  it("accepts the repository's release packages as aligned", () => {
    expect(findVersionMismatches(readReleaseVersions(`${import.meta.dirname}/..`))).toEqual([]);
  });
});
