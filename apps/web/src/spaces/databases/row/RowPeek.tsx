import { Link } from "@tanstack/react-router";
import type { SpacePageNavigationTarget } from "@t2code/client-runtime/spaces";
import { ArrowUpRightIcon, XIcon } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";

import { Button } from "~/components/ui/button";
import SpacePageSurface from "../../SpacePageSurface";
import { RowPeekContext } from "./rowPeekContext";

/** A row beside its table. Not modal: the table stays usable, and opening another row swaps it. */
export default function RowPeek({
  target,
  onClose,
}: {
  readonly target: SpacePageNavigationTarget;
  readonly onClose: () => void;
}): ReactNode {
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // Popups and editors portal out of the aside and handle their own Escape first.
    if (
      event.key !== "Escape" ||
      event.defaultPrevented ||
      !(event.target instanceof Node) ||
      !event.currentTarget.contains(event.target)
    )
      return;
    event.stopPropagation();
    onClose();
  };
  return (
    <aside
      aria-label="Row peek"
      className="flex min-h-0 min-w-0 flex-col border-l bg-background max-lg:absolute max-lg:inset-0 max-lg:z-20 lg:w-[34rem] lg:shrink-0"
      onKeyDown={onKeyDown}
    >
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b px-3">
        <Button
          variant="ghost"
          size="xs"
          render={
            <Link
              to="/spaces/$environmentId/$spaceId/$pageId"
              params={target}
              search={{}}
              aria-label="Open as full page"
            />
          }
        >
          <ArrowUpRightIcon />
          Open as full page
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label="Close peek" onClick={onClose}>
          <XIcon />
        </Button>
      </div>
      <RowPeekContext.Provider value={null}>
        <SpacePageSurface
          target={target}
          peek={{ close: onClose, isOpen: (pageId) => pageId === target.pageId }}
        />
      </RowPeekContext.Provider>
    </aside>
  );
}
