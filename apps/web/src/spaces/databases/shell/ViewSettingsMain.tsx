import { filterShape } from "@t2code/client-runtime/spaces";
import {
  ArrowDownUpIcon,
  ChevronRightIcon,
  CopyIcon,
  GroupIcon,
  LayoutIcon,
  LinkIcon,
  ListFilterIcon,
  ListTreeIcon,
  PanelRightIcon,
  RowsIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
} from "lucide-react";
import type { ComponentType } from "react";

import { DraftInput } from "~/components/ui/draft-input";
import { Separator } from "~/components/ui/separator";
import { cn } from "~/lib/utils";
import { OpenPagesInRow } from "../controls/OpenPagesInRow";
import { OptionSelect } from "../controls/OptionSelect";
import { useViewControls } from "../controls/useViewControls";
import type { OpenControl } from "./context";
import { TabIcon } from "./ViewTab";
import { ROW_CLASS } from "./ViewsOverflow";
import { VIEW_REGISTRY } from "./viewRegistry";
import { useCopyViewLink } from "./useCopyViewLink";

export type Page = Exclude<OpenControl, null> | "main";
const LOAD_LIMITS = [10, 25, 50, 100] as const;
const LOAD_LIMIT_CHOICES = LOAD_LIMITS.map((limit) => ({
  value: String(limit),
  label: `${limit} pages`,
}));
const count = (n: number, noun: string) => (n === 0 ? "None" : `${n} ${noun}${n === 1 ? "" : "s"}`);

function SettingsRow({
  icon: Icon,
  label,
  value,
  onClick,
  destructive = false,
  disabled = false,
}: {
  readonly icon: ComponentType<{ className?: string }>;
  readonly label: string;
  readonly value?: string;
  readonly onClick: () => void;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={cn(ROW_CLASS, "disabled:opacity-50", destructive && "text-destructive-foreground")}
      onClick={onClick}
    >
      <Icon className={cn("size-4 shrink-0", !destructive && "text-muted-foreground")} />
      {label}
      {value === undefined ? null : (
        <span className="ms-auto max-w-32 truncate text-muted-foreground">{value}</span>
      )}
      {value === undefined ? null : (
        <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
      )}
    </button>
  );
}

export function MainPage({
  viewCount,
  manage,
  go,
  onDuplicate,
  onDelete,
}: {
  readonly viewCount: number;
  readonly manage: boolean;
  readonly go: (page: Page) => void;
  readonly onDuplicate: () => void;
  readonly onDelete: () => void;
}) {
  const { model, view, known, columns, dataSource, actions, canEditView } = useViewControls();
  const copyLink = useCopyViewLink(model);
  const type = known?.type;
  const grouped = columns.find((column) => column.property.id === known?.group?.property);
  const loadLimit = String(known?.layout.loadLimit ?? 100);
  return (
    <div className="w-72 max-w-[calc(100vw-2rem)] pb-1">
      <p className="px-3 pt-3 pb-1 text-sm font-medium">View settings</p>
      <div className="flex items-center gap-2 px-3 pb-2">
        <TabIcon type={view.type} />
        <DraftInput
          size="compact"
          aria-label="View name"
          readOnly={!canEditView}
          value={view.name}
          onCommit={(name) => actions.renameView(view.id, name)}
        />
      </div>
      <Separator />
      <div className="p-1">
        <SettingsRow
          icon={LayoutIcon}
          label="Layout"
          value={type === undefined ? "" : VIEW_REGISTRY[type].label}
          onClick={() => go("layout")}
        />
        <SettingsRow
          icon={SlidersHorizontalIcon}
          label="Property visibility"
          value={String(columns.filter((column) => column.visible).length)}
          onClick={() => go("properties")}
        />
        <SettingsRow
          icon={ListFilterIcon}
          label="Filter"
          value={count(filterShape(known?.filter).conditions, "filter")}
          onClick={() => go("filter")}
        />
        <SettingsRow
          icon={ArrowDownUpIcon}
          label="Sort"
          value={count(known?.sorts.length ?? 0, "sort")}
          onClick={() => go("sort")}
        />
        <SettingsRow
          icon={GroupIcon}
          label="Group"
          value={grouped?.property.name ?? "None"}
          onClick={() => go("group")}
        />
        {type === "table" || type === "list" ? (
          <SettingsRow
            icon={ListTreeIcon}
            label="Sub-items"
            value={dataSource.subItems === undefined ? "Off" : "On"}
            onClick={() => go("subItems")}
          />
        ) : null}
        {type === "table" || type === "board" || type === "list" || type === "gallery" ? (
          <div className="flex h-7 items-center gap-2 px-2 text-sm">
            <RowsIcon className="size-4 shrink-0 text-muted-foreground" />
            Load limit
            <span className="ms-auto">
              <OptionSelect
                label="Load limit"
                value={loadLimit}
                choices={LOAD_LIMIT_CHOICES}
                disabled={!canEditView}
                onChange={(next) => {
                  const limit = LOAD_LIMITS.find((candidate) => String(candidate) === next);
                  if (known && limit !== undefined)
                    actions.editView({ layout: { ...known.layout, loadLimit: limit } });
                }}
              />
            </span>
          </div>
        ) : null}
        <div className="flex items-center gap-2 px-2 text-sm">
          <PanelRightIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <OpenPagesInRow />
          </span>
        </div>
      </div>
      <Separator />
      <div className="p-1">
        <SettingsRow icon={LinkIcon} label="Copy link to view" onClick={() => copyLink(view.id)} />
        {manage ? (
          <>
            <SettingsRow icon={CopyIcon} label="Duplicate view" onClick={onDuplicate} />
            <SettingsRow
              icon={Trash2Icon}
              label="Delete view"
              destructive
              disabled={viewCount < 2}
              onClick={onDelete}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}
