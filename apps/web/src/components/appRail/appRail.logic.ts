export const APP_RAIL_WIDTH_PX = 48;

export type AppRailItem =
  | "spaces"
  | "threads"
  | "pull-requests"
  | "usage"
  | "scheduled-tasks"
  | "settings";

export function isAppRailPath(pathname: string, item: Exclude<AppRailItem, "threads">): boolean {
  switch (item) {
    case "spaces":
      return pathname === "/spaces" || pathname.startsWith("/spaces/");
    case "pull-requests":
      return pathname === "/pull-requests" || pathname.startsWith("/pull-requests/");
    case "usage":
      return pathname === "/usage" || pathname.startsWith("/usage/");
    case "scheduled-tasks":
      return pathname === "/scheduled-tasks" || pathname.startsWith("/scheduled-tasks/");
    case "settings":
      return pathname === "/settings" || pathname.startsWith("/settings/");
  }
}

/** Threads is the fallback: chat routes are everything that is not a utility page. */
export function resolveAppRailActiveItem(pathname: string): AppRailItem {
  if (isAppRailPath(pathname, "spaces")) return "spaces";
  if (isAppRailPath(pathname, "pull-requests")) return "pull-requests";
  if (isAppRailPath(pathname, "usage")) return "usage";
  if (isAppRailPath(pathname, "scheduled-tasks")) return "scheduled-tasks";
  if (isAppRailPath(pathname, "settings")) return "settings";
  return "threads";
}
