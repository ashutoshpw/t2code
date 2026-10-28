import { createFileRoute, Outlet } from "@tanstack/react-router";
import { EnvironmentId } from "@t2code/contracts";

export const Route = createFileRoute("/_chat/spaces")({
  validateSearch: (raw: Record<string, unknown>): { environmentId?: EnvironmentId } =>
    typeof raw.environmentId === "string" && raw.environmentId.length > 0
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {},
  component: Outlet,
});
