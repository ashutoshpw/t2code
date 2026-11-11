import { describe, expect, it } from "vite-plus/test";

import { databaseErrorMessage } from "./errors";

describe("databaseErrorMessage", () => {
  it.each([
    [{ _tag: "SpaceDatabaseError", reason: "duplicate_name" }, "That name is already used."],
    [
      { _tag: "SpaceDatabaseError", reason: "last_option" },
      "A property needs at least one option.",
    ],
    [
      { _tag: "SpaceDatabaseError", reason: "something_new" },
      "The database request couldn't be completed.",
    ],
    [
      { _tag: "SpaceLimitExceededError", limit: "maxRowsPerDataSource" },
      "This database has reached its row limit.",
    ],
    [{ _tag: "SpaceLimitExceededError", limit: "other" }, "That is over a limit of this database."],
    [{ _tag: "SpaceValidationError", reason: "trashed" }, "This item is in the trash."],
    [
      new Error("Couldn't prepare the change. Try again."),
      "Couldn't prepare the change. Try again.",
    ],
    ["boom", "Something went wrong. Try again."],
  ])("%j", (failure, expected) => {
    expect(databaseErrorMessage(failure)).toBe(expected);
  });

  it("uses no em dashes", () => {
    expect(databaseErrorMessage({ _tag: "SpaceValidationError" })).not.toContain("—");
  });
});
