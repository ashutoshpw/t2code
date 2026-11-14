import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId } from "@t2code/contracts";
import { createWriteFailures, failuresOf, writerRejects } from "./spacesDatabaseWriter";

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
  const env = (id: string) => EnvironmentId.make(id);
  const entry = (environmentId: string, message: string) => ({
    environmentId: env(environmentId),
    dataSourceId: undefined,
    message,
  });

  it("keeps the newest few per environment, notifies, and dismisses by id", () => {
    const failures = createWriteFailures(2);
    let notified = 0;
    const stop = failures.subscribe(() => notified++);
    failures.add(entry("a", "one"));
    failures.add(entry("a", "two"));
    failures.add(entry("a", "three"));
    expect(failures.getSnapshot().map((item) => item.message)).toEqual(["two", "three"]);
    const [first] = failures.getSnapshot();
    failures.dismiss(first!.id);
    expect(failures.getSnapshot().map((item) => item.message)).toEqual(["three"]);
    expect(notified).toBe(4);
    stop();
    failures.add(entry("a", "four"));
    expect(notified).toBe(4);
  });

  it("does not let one environment push out another's failures", () => {
    const failures = createWriteFailures(1);
    failures.add(entry("a", "from a"));
    failures.add(entry("b", "from b"));
    failures.add(entry("b", "again from b"));
    const all = failures.getSnapshot();
    expect(failuresOf(all, env("a")).map((item) => item.message)).toEqual(["from a"]);
    expect(failuresOf(all, env("b")).map((item) => item.message)).toEqual(["again from b"]);
  });
});
