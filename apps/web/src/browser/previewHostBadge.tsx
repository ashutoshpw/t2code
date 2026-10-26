import type { DesktopPreviewHostState, EnvironmentId } from "@t2code/contracts";

import { Badge } from "~/components/ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import { usePreviewHostStore } from "./previewHost";

export interface PreviewHostBadgeState {
  readonly label: string;
  readonly connecting: boolean;
  readonly tooltip: string;
}

/** Content for a live hosting session; a closed or unhosted environment shows no badge. */
function previewHostBadge(
  status: DesktopPreviewHostState["status"] | undefined,
): PreviewHostBadgeState | null {
  if (status === "connecting") {
    return {
      label: "On this device",
      connecting: true,
      tooltip: "Connecting your desktop's browser to serve this environment…",
    };
  }
  if (status === "connected") {
    return {
      label: "On this device",
      connecting: false,
      tooltip:
        "Your desktop's browser serves this environment, so tabs open here instead of in a headless browser on the host.",
    };
  }
  return null;
}

function usePreviewHostBadge(environmentId: EnvironmentId): PreviewHostBadgeState | null {
  return previewHostBadge(
    usePreviewHostStore((state) => state.statusByEnvironmentId[environmentId]),
  );
}

/** Marks a preview tab whose environment this app serves with its own browser. */
export function PreviewHostBadge({ environmentId }: { environmentId: EnvironmentId }) {
  const state = usePreviewHostBadge(environmentId);
  if (!state) return null;
  return (
    <Tooltip>
      <TooltipTrigger render={<Badge variant="outline" className="max-w-28 shrink-0" />}>
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 flex-none rounded-full",
            state.connecting
              ? "motion-safe:animate-status-pulse bg-muted-foreground"
              : "bg-success",
          )}
        />
        <span className="truncate">{state.label}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">{state.tooltip}</TooltipPopup>
    </Tooltip>
  );
}
