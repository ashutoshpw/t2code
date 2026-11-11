import { filterShape } from "@t2code/client-runtime/spaces";
import { ArrowDownUpIcon, FilterIcon, GroupIcon, SlidersHorizontalIcon } from "lucide-react";
import type { ComponentType, ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useOpenControl, type OpenControl } from "../shell/context";
import { FilterPopover } from "./FilterPopover";
import { GroupPopover } from "./GroupPopover";
import { PropertiesPopover } from "./PropertiesPopover";
import { SortPopover } from "./SortPopover";
import { useViewControls } from "./useViewControls";

type Control = Exclude<OpenControl, null>;

function ControlButton({
  control,
  label,
  detail,
  icon: Icon,
  disabled,
  children,
}: {
  readonly control: Control;
  readonly label: string;
  readonly detail?: string;
  readonly icon: ComponentType;
  readonly disabled: boolean;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useOpenControl();
  const active = detail !== undefined;
  if (disabled)
    return (
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>
          <Button variant="ghost-muted" size="xs" disabled>
            <Icon />
            {label}
          </Button>
        </TooltipTrigger>
        <TooltipPopup>You have read-only access</TooltipPopup>
      </Tooltip>
    );
  return (
    <Popover open={open === control} onOpenChange={(next) => setOpen(next ? control : null)}>
      <PopoverTrigger
        render={
          <Button
            variant={active ? "secondary" : "ghost-muted"}
            size="xs"
            aria-label={detail === undefined ? label : `${label} ${detail}`}
          />
        }
      >
        <Icon />
        {label}
        {detail === undefined ? null : <span className="tabular-nums">{detail}</span>}
      </PopoverTrigger>
      <PopoverPopup align="start" padding="compact">
        {children}
      </PopoverPopup>
    </Popover>
  );
}

/** Filter, Sort, Group and Properties: each edits the active view through `actions.editView`. */
export function ViewControls(): ReactNode {
  const { known, columns, model } = useViewControls();
  const disabled = !model.permissions.views || known === null;
  const conditions = filterShape(known?.filter).conditions;
  const sorts = known?.sorts.length ?? 0;
  const grouped = columns.find((column) => column.property.id === known?.group?.property);
  return (
    <>
      <ControlButton
        control="filter"
        label="Filter"
        icon={FilterIcon}
        disabled={disabled}
        {...(conditions > 0 ? { detail: String(conditions) } : {})}
      >
        <FilterPopover />
      </ControlButton>
      <ControlButton
        control="sort"
        label="Sort"
        icon={ArrowDownUpIcon}
        disabled={disabled}
        {...(sorts > 0 ? { detail: String(sorts) } : {})}
      >
        <SortPopover />
      </ControlButton>
      <ControlButton
        control="group"
        label="Group"
        icon={GroupIcon}
        disabled={disabled}
        {...(grouped === undefined ? {} : { detail: grouped.property.name })}
      >
        <GroupPopover />
      </ControlButton>
      <ControlButton
        control="properties"
        label="Properties"
        icon={SlidersHorizontalIcon}
        disabled={disabled}
      >
        <PropertiesPopover />
      </ControlButton>
    </>
  );
}
