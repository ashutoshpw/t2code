import type {
  SpaceDatabaseColor,
  SpaceKnownDatabaseProperty,
  SpaceOptionId,
  SpaceStatusGroup,
} from "@t2code/contracts/spaces";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { DraftInput } from "~/components/ui/draft-input";
import { Input } from "~/components/ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { useDatabaseActions } from "../shell/context";
import { OPTION_DOT_CLASS } from "../primitives/colors";
import { ColorSwatches } from "../primitives/ColorSwatches";
import { cn } from "~/lib/utils";
import { STATUS_GROUP_LABELS } from "./filterLabels";
import { OptionSelect } from "./OptionSelect";
import { SortableList, SortableRow } from "./Sortable";
import { beforeIdAfterMove, movedId, nextConfig } from "./propertyConfig";

type OptionProperty = Extract<
  SpaceKnownDatabaseProperty,
  { type: "select" | "multi_select" | "status" }
>;
type Option = OptionProperty["config"]["options"][number];
const GROUPS: ReadonlyArray<SpaceStatusGroup> = ["todo", "in_progress", "complete"];

function OptionRow({
  property,
  option,
  disabled,
}: {
  readonly property: OptionProperty;
  readonly option: Option;
  readonly disabled: boolean;
}) {
  const actions = useDatabaseActions();
  const [deleting, setDeleting] = useState(false);
  return (
    <SortableRow id={option.id} label={option.name} disabled={disabled}>
      <Popover>
        <PopoverTrigger
          render={
            <button
              type="button"
              disabled={disabled}
              aria-label={`Color of ${option.name}`}
              className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            />
          }
        >
          <span className={cn("size-3 rounded-full", OPTION_DOT_CLASS[option.color])} />
        </PopoverTrigger>
        <PopoverPopup align="start" padding="compact">
          <ColorSwatches
            value={option.color}
            onChange={(color: SpaceDatabaseColor) =>
              void actions.updateSchema([
                { op: "updateOption", propertyId: property.id, optionId: option.id, color },
              ])
            }
          />
        </PopoverPopup>
      </Popover>
      <div className="min-w-0 flex-1">
        <DraftInput
          size="compact"
          aria-label={`Name of ${option.name}`}
          disabled={disabled}
          value={option.name}
          onCommit={(name) => {
            if (name.trim() !== "")
              void actions.updateSchema([
                {
                  op: "updateOption",
                  propertyId: property.id,
                  optionId: option.id,
                  name: name.trim(),
                },
              ]);
          }}
        />
      </div>
      <Button
        variant="ghost-destructive"
        size="icon-xs"
        disabled={disabled}
        aria-label={`Delete ${option.name}`}
        onClick={() => setDeleting(true)}
      >
        <Trash2Icon />
      </Button>
      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {option.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Rows lose this option. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
            <AlertDialogClose
              render={<Button variant="destructive" />}
              onClick={() =>
                void actions.updateSchema([
                  { op: "removeOption", propertyId: property.id, optionId: option.id },
                ])
              }
            >
              Delete option
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SortableRow>
  );
}

function AddOption({
  property,
  group,
  disabled,
}: {
  readonly property: OptionProperty;
  readonly group?: SpaceStatusGroup;
  readonly disabled: boolean;
}) {
  const actions = useDatabaseActions();
  const [name, setName] = useState("");
  const add = () => {
    const trimmed = name.trim();
    if (trimmed === "") return;
    void actions.addOption(property.id, trimmed, group).then((id) => {
      if (id !== null) setName("");
    });
  };
  return (
    <div className="flex items-center gap-1.5">
      <Input
        size="compact"
        aria-label={group === undefined ? "New option" : `New ${STATUS_GROUP_LABELS[group]} option`}
        placeholder="New option"
        disabled={disabled}
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            add();
          }
        }}
      />
      <Button
        variant="ghost-muted"
        size="xs"
        disabled={disabled || name.trim() === ""}
        aria-label={group === undefined ? "Add option" : `Add ${STATUS_GROUP_LABELS[group]} option`}
        onClick={add}
      >
        <PlusIcon />
        Add
      </Button>
    </div>
  );
}

function OptionList({
  property,
  options,
  disabled,
}: {
  readonly property: OptionProperty;
  readonly options: ReadonlyArray<Option>;
  readonly disabled: boolean;
}) {
  const actions = useDatabaseActions();
  const ids = options.map((option) => option.id);
  return (
    <SortableList
      ids={ids}
      onReorder={(next) => {
        const moved = movedId(ids, next);
        if (moved === null) return;
        const before = beforeIdAfterMove(next, moved);
        void actions.updateSchema([
          {
            op: "moveOption",
            propertyId: property.id,
            optionId: moved as SpaceOptionId,
            beforeOptionId: before as SpaceOptionId | null,
          },
        ]);
      }}
    >
      <div className="space-y-1.5">
        {options.map((option) => (
          <OptionRow key={option.id} property={property} option={option} disabled={disabled} />
        ))}
      </div>
    </SortableList>
  );
}

/** Select, multi-select and status options: add, rename, recolor, reorder, delete. */
export function OptionsEditor({
  property,
  disabled,
}: {
  readonly property: OptionProperty;
  readonly disabled: boolean;
}) {
  const actions = useDatabaseActions();
  const options = property.config.options as ReadonlyArray<Option>;
  if (property.type !== "status")
    return (
      <div className="space-y-1.5">
        <span className="text-xs text-muted-foreground">Options</span>
        <OptionList property={property} options={options} disabled={disabled} />
        <AddOption property={property} disabled={disabled} />
      </div>
    );
  const statusOptions = options as ReadonlyArray<Extract<Option, { group: SpaceStatusGroup }>>;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">Default</span>
        <OptionSelect
          label="Default option"
          disabled={disabled}
          value={property.config.defaultOptionId ?? null}
          placeholder="None"
          choices={options.map((option) => ({ value: option.id, label: option.name }))}
          onChange={(defaultOptionId) =>
            void actions.updateSchema([
              {
                op: "updateProperty",
                propertyId: property.id,
                config: nextConfig(property, { defaultOptionId }),
              },
            ])
          }
        />
      </div>
      {GROUPS.map((group) => (
        <div
          key={group}
          role="group"
          aria-label={STATUS_GROUP_LABELS[group]}
          className="space-y-1.5"
        >
          <span className="text-xs text-muted-foreground">{STATUS_GROUP_LABELS[group]}</span>
          <OptionList
            property={property}
            options={statusOptions.filter((option) => option.group === group)}
            disabled={disabled}
          />
          <AddOption property={property} group={group} disabled={disabled} />
        </div>
      ))}
    </div>
  );
}
