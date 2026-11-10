import { assert, it } from "@effect/vitest";

import {
  repositoryPathFromRemoteUrl,
  transportSafeSourceControlErrorValue,
} from "./SourceControlProvider.ts";

it("removes URL credentials, query parameters, and fragments from error transport values", () => {
  assert.strictEqual(
    transportSafeSourceControlErrorValue(
      "https://user:secret@example.test/org/repo/pull/42?token=secret#discussion",
    ),
    "https://example.test/org/repo/pull/42",
  );
});

it.each([
  ["git@github.com:Ashutoshpw/t2code.git", "Ashutoshpw/t2code"],
  ["github.com:Ashutoshpw/t2code.git", "Ashutoshpw/t2code"],
  ["gitlab.com:T2Tools/platform/t2code", "T2Tools/platform/t2code"],
  ["https://github.com/Ashutoshpw/t2code.git", "Ashutoshpw/t2code"],
  ["C:/repos/t3code", null],
])("reads the repository path of %s", (remoteUrl, expected) => {
  assert.strictEqual(repositoryPathFromRemoteUrl(remoteUrl), expected);
});
