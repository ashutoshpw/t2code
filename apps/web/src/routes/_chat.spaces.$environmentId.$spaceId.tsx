import { createFileRoute, Outlet } from "@tanstack/react-router";
export const Route = createFileRoute("/_chat/spaces/$environmentId/$spaceId")({
  component: Outlet,
});
