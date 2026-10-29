import { SpacePageShareError } from "@t2code/contracts";
import * as Schema from "effect/Schema";

const isShareError = Schema.is(SpacePageShareError);

/** Plain-language text for a failed page share request; links are made on the machine, not here. */
export function pageShareErrorMessage(error: unknown): string {
  if (!isShareError(error)) return "Could not update the page share. Try again.";
  switch (error.reason) {
    case "disabled":
      return "Page links are off. Turn on Page links in Settings > Labs on the machine running T2 Code.";
    case "connect_unavailable":
      return "Page links need T2 Connect running on that machine. Link it there, then try again.";
    default:
      return error.message;
  }
}
