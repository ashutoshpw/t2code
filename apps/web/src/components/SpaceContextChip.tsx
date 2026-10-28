import { useEffect, useState } from "react";
import type {
  BlockContextRecord,
  PageContextRecord,
  SpaceContextSelector,
} from "@t2code/contracts";
import type { SpacePageNavigationTarget } from "@t2code/client-runtime/spaces";
import { useRouter } from "@tanstack/react-router";
import { FileTextIcon } from "lucide-react";
import { useSpaceReferenceController } from "../spaces/useSpaceReferences";
import { useMainAppThreadRef } from "./sidebar/mainAppLocation";
import { useRightPanelStore } from "../rightPanelStore";
import { ContextChip, ContextChipLabel } from "./ContextChip";
import { UnresolvedChip } from "./contextChipParts";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function SpaceContextChip({
  record,
  copyMarkdown,
}: {
  record: SpaceContextSelector | PageContextRecord | BlockContextRecord;
  copyMarkdown?: string | undefined;
}) {
  const controller = useSpaceReferenceController(record.environmentId);
  const router = useRouter();
  const threadRef = useMainAppThreadRef();
  const target =
    record.kind === "block"
      ? { kind: "block" as const, blockId: record.blockId }
      : { kind: "page" as const, pageId: record.pageId };
  const identity = JSON.stringify(target);
  const [resolved, setResolved] = useState<{
    controller: typeof controller;
    identity: string;
    current: () => SpacePageNavigationTarget | null;
  } | null>(null);
  // oxlint-disable-next-line t2code/react-effect-budget -- resolve current source metadata without retaining source bodies and discard obsolete owners.
  useEffect(() => {
    let active = true;
    if (!controller) return;
    void controller.resolve(target).then((result) => {
      if (active) setResolved(result ? { controller, identity, current: result.current } : null);
    });
    return () => {
      active = false;
      controller.invalidate();
    };
  }, [controller, identity, target]);
  const current =
    resolved?.controller === controller && resolved.identity === identity
      ? resolved.current()
      : null;
  const label = record.label || ("title" in record ? record.title : "");
  const detail =
    "snapshot" in record
      ? record.snapshot.truncated
        ? "Stored snapshot was shortened to fit capture limits."
        : "Stored snapshot is preserved."
      : record.includeChildPages
        ? "Child pages will be included within capture limits when sent."
        : "Child pages are excluded. Content is captured when sent.";
  if (!current)
    return (
      <UnresolvedChip
        label={label}
        {...(copyMarkdown === undefined ? {} : { copyMarkdown })}
        tooltip={`Current Spaces content is unavailable. ${detail}`}
      />
    );
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ContextChip
            kind="citation"
            render={<button type="button" />}
            data-markdown-copy={copyMarkdown}
            onClick={() => {
              if (!controller) return;
              const href = router.state.location.href;
              void controller.resolve(target).then((result) => {
                if (router.state.location.href !== href) return;
                const location = result?.current();
                if (!result || !location) {
                  setResolved(null);
                  return;
                }
                setResolved({ controller, identity, current: result.current });
                if (threadRef) useRightPanelStore.getState().openSpacePage(threadRef, location);
                else
                  void router.navigate({
                    to: "/spaces/$environmentId/$spaceId/$pageId",
                    params: location,
                    search: location.blockId ? { block: location.blockId } : {},
                  });
              });
            }}
          >
            <FileTextIcon />
            <ContextChipLabel>{label}</ContextChipLabel>
          </ContextChip>
        }
      />
      <TooltipPopup side="top">
        Open current {record.kind}. {detail}
      </TooltipPopup>
    </Tooltip>
  );
}
