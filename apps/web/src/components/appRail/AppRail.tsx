import {
  CalendarClockIcon,
  ChartNoAxesColumnIcon,
  MessagesSquareIcon,
  SettingsIcon,
} from "lucide-react";
import { memo, type ReactNode } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { isElectron } from "../../env";
import { useNavigateToMainApp } from "../sidebar/mainAppLocation";
import { usePullRequestsSupported } from "../../state/environments";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "../../lib/utils";
import { isAppRailPath, resolveAppRailActiveItem, type AppRailItem } from "./appRail.logic";

function AppRailButton({
  icon,
  label,
  active,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            aria-current={active ? "page" : undefined}
            aria-label={label}
            className={cn(
              "flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-(--control-radius) text-sidebar-muted-foreground/80 outline-hidden ring-ring hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset active:bg-sidebar-row-active active:text-sidebar-foreground [&>svg]:size-4 [&>svg]:shrink-0",
              active &&
                "bg-sidebar-row-selected text-sidebar-foreground [&>svg]:text-sidebar-foreground",
            )}
            onClick={onClick}
          >
            {icon}
          </button>
        }
      />
      <TooltipPopup side="right">{label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Always-visible left navigation for utility pages. It sits outside the
 * resizable sidebar: the sidebar's fixed container offsets itself by
 * `--app-rail-width`, and a collapsed sidebar slides behind the rail.
 */
export const AppRail = memo(function AppRail() {
  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  const pathname = useLocation({ select: (location) => location.pathname });
  const activeItem = resolveAppRailActiveItem(pathname);
  const pullRequestsSupported = usePullRequestsSupported();

  const items: ReadonlyArray<{
    readonly item: AppRailItem;
    readonly label: string;
    readonly icon: ReactNode;
    readonly onClick: () => void;
  }> = [
    {
      item: "threads",
      label: "Threads",
      icon: <MessagesSquareIcon />,
      onClick: () => void navigateToMainApp(),
    },
    {
      item: "pull-requests",
      label: "Pull Requests",
      icon: <PullRequestGlyph.pullRequest />,
      onClick: () =>
        void navigate({ to: "/pull-requests", search: readPullRequestListPreferences() }),
    },
    {
      item: "usage",
      label: "Usage",
      icon: <ChartNoAxesColumnIcon />,
      onClick: () => void navigate({ to: "/usage" }),
    },
    {
      item: "scheduled-tasks",
      label: "Scheduled tasks",
      icon: <CalendarClockIcon />,
      onClick: () => void navigate({ to: "/scheduled-tasks" }),
    },
  ];

  return (
    <nav
      aria-label="App navigation"
      className="z-20 hidden w-12 shrink-0 flex-col items-center border-r bg-sidebar surface-grain text-sidebar-foreground md:flex"
      data-slot="app-rail"
    >
      {/* Only macOS desktop sets --app-rail-top-inset, to clear the traffic
          lights; elsewhere the buttons start at the top. */}
      <div
        className={cn("w-full shrink-0", isElectron && "drag-region")}
        style={{ height: "var(--app-rail-top-inset, 0px)" }}
      />
      <div className="flex min-h-0 flex-1 flex-col items-center gap-1 pt-2">
        {items.map(({ item, label, icon, onClick }) =>
          item === "pull-requests" && !pullRequestsSupported ? null : (
            <AppRailButton
              key={item}
              active={activeItem === item}
              icon={icon}
              label={label}
              onClick={onClick}
            />
          ),
        )}
      </div>
      <div className="flex flex-col items-center gap-1 pb-2">
        <AppRailButton
          active={isAppRailPath(pathname, "settings")}
          icon={<SettingsIcon />}
          label="Settings"
          onClick={() => void navigate({ to: "/settings" })}
        />
      </div>
    </nav>
  );
});
