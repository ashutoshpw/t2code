import { describe, expect, it } from "vite-plus/test";

import { readSpacesDatabaseTarget } from "./navigation";

const base = { environmentId: "env", spaceId: "space", pageId: "page", blockId: "block" };

describe("readSpacesDatabaseTarget", () => {
  it("reads a link and a push from a block", () => {
    expect(readSpacesDatabaseTarget(base)).toEqual(base);
    expect(
      readSpacesDatabaseTarget({ ...base, viewId: "v2", databaseId: "db", viewIds: ["v1", "v2"] }),
    ).toEqual({ ...base, viewId: "v2", block: { databaseId: "db", viewIds: ["v1", "v2"] } });
  });

  it("refuses missing, mistyped, half-given and oversized params", () => {
    expect(readSpacesDatabaseTarget(undefined)).toBeNull();
    expect(readSpacesDatabaseTarget({ ...base, blockId: undefined })).toBeNull();
    expect(readSpacesDatabaseTarget({ ...base, pageId: 4 })).toBeNull();
    expect(readSpacesDatabaseTarget({ ...base, databaseId: "db" })).toBeNull();
    expect(readSpacesDatabaseTarget({ ...base, viewIds: ["v1"] })).toBeNull();
    expect(readSpacesDatabaseTarget({ ...base, blockId: "x".repeat(257) })).toBeNull();
    expect(
      readSpacesDatabaseTarget({ ...base, databaseId: "db", viewIds: ["v".repeat(257)] }),
    ).toBeNull();
    expect(
      readSpacesDatabaseTarget({
        ...base,
        databaseId: "db",
        viewIds: Array.from({ length: 101 }, (_, index) => `v${index}`),
      }),
    ).toBeNull();
  });
});
