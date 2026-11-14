import { filterShape } from "@t2code/client-runtime/spaces";
import { ArrowDownUpIcon, ListFilterIcon } from "lucide-react";
import type { ComponentType, ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useOpenControl } from "../shell/context";
import { FilterPopover } from "./FilterPopover";
import { SortPopover } from "./SortPopover";
import { useViewControls } from "./useViewControls";

function ControlButton({
  control,
  label,
  count,
  icon: Icon,
  disabled,
  children,
}: {
  readonly control: "filter" | "sort";
  readonly label: string;
  readonly count: number;
  readonly icon: ComponentType<{ className?: string }>;
  readonly disabled: boolean;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useOpenControl();
  const active = count > 0;
  const noun = label.toLowerCase();
  if (disabled)
    return (
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>
          <Button variant="ghost-muted" size="icon-sm" aria-label={label} disabled>
            <Icon className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipPopup side="bottom">You have read-only access</TooltipPopup>
      </Tooltip>
    );
  return (
    <Popover open={open === control} onOpenChange={(next) => setOpen(next ? control : null)}>
      <Tooltip>
        <TooltipTrigger render={<span className="relative inline-flex" />}>
          <PopoverTrigger
            render={
              <Button
                variant="ghost-muted"
                size="icon-sm"
                aria-label={active ? `${label} ${count}` : label}
              />
            }
          >
            <Icon className={active ? "size-4 text-primary" : "size-4"} />
          </PopoverTrigger>
          {active ? (
            <span
              aria-hidden
              className="pointer-events-none absolute end-1 top-1 size-1.5 rounded-full bg-primary"
            />
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          {active ? `${count} ${noun}${count === 1 ? "" : "s"}` : label}
        </TooltipPopup>
      </Tooltip>
      <PopoverPopup align="end" padding="compact">
        {children}
      </PopoverPopup>
    </Popover>
  );
}

/** Filter and Sort of the active view: icon buttons whose popovers edit it through `actions.editView`. */
export function ViewControls(): ReactNode {
  const { known, model } = useViewControls();
  const disabled = !model.permissions.views || known === null;
  return (
    <>
      <ControlButton
        control="filter"
        label="Filter"
        icon={ListFilterIcon}
        disabled={disabled}
        count={filterShape(known?.filter).conditions}
      >
        <FilterPopover />
      </ControlButton>
      <ControlButton
        control="sort"
        label="Sort"
        icon={ArrowDownUpIcon}
        disabled={disabled}
        count={known?.sorts.length ?? 0}
      >
        <SortPopover />
      </ControlButton>
    </>
  );
}
