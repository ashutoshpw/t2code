import { Link } from "@tanstack/react-router";
import type { SpacesAvailability } from "@t2code/client-runtime/state/spaces";

export function SpacesUnavailable({ availability }: { availability: SpacesAvailability }) {
  const message =
    availability === "unsupported-version"
      ? "Update T2 Code to open this version of Spaces."
      : availability === "denied"
        ? "This connection cannot read Spaces."
        : availability === "disconnected"
          ? "Connect to this environment to open Spaces."
          : "Spaces is disabled or unavailable in this environment.";
  return (
    <div className="p-4">
      <h1 className="text-lg font-semibold">Spaces unavailable</h1>
      <p className="mt-2 text-sm text-muted-foreground">{message}</p>
      <Link to="/settings/labs" className="mt-3 inline-block text-sm underline">
        Spaces settings
      </Link>
    </div>
  );
}
