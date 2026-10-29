import { SpacePageShareError } from "@t2code/contracts";
import { expect, it } from "vite-plus/test";

import { pageShareErrorMessage } from "./pageShareCopy";

it("tells the owner where to turn page links on", () => {
  expect(pageShareErrorMessage(new SpacePageShareError({ reason: "disabled" }))).toContain(
    "Settings > Labs on the machine",
  );
});

it("explains a missing T2 Connect tunnel and keeps other messages", () => {
  expect(
    pageShareErrorMessage(new SpacePageShareError({ reason: "connect_unavailable" })),
  ).toContain("T2 Connect");
  expect(pageShareErrorMessage(new SpacePageShareError({ reason: "page_unavailable" }))).toBe(
    "This page cannot be shared.",
  );
  expect(pageShareErrorMessage(new Error("boom"))).toBe(
    "Could not update the page share. Try again.",
  );
});
