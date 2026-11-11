import { describe, expect, it } from "vite-plus/test";

import { createWriteFailures, writerRejects } from "./spacesDatabaseWriter";

describe("writerRejects", () => {
  it("drops refused values and keeps transport failures for retry", () => {
    for (const _tag of [
      "SpaceDatabaseError",
      "SpaceNotFoundError",
      "SpaceLimitExceededError",
      "SpaceValidationError",
    ])
      expect(writerRejects({ _tag })).toBe(true);
    expect(writerRejects({ _tag: "EnvironmentAuthorizationError" })).toBe(false);
    expect(writerRejects(new Error("offline"))).toBe(false);
    expect(writerRejects(undefined)).toBe(false);
  });
});

describe("createWriteFailures", () => {
  it("keeps the newest few, notifies, and dismisses by id", () => {
    const failures = createWriteFailures(2);
    let notified = 0;
    const stop = failures.subscribe(() => notified++);
    failures.add("one");
    failures.add("two");
    failures.add("three");
    expect(failures.getSnapshot().map((entry) => entry.message)).toEqual(["two", "three"]);
    const [first] = failures.getSnapshot();
    failures.dismiss(first!.id);
    expect(failures.getSnapshot().map((entry) => entry.message)).toEqual(["three"]);
    expect(notified).toBe(4);
    stop();
    failures.add("four");
    expect(notified).toBe(4);
  });
});
