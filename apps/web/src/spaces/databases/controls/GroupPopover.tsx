import { canonicalJson } from "@t2code/client-runtime/spaces";
import {
  SPACE_GROUPABLE_TYPES,
  type SpaceKnownGroup,
  type SpaceKnownGroupBy,
  type SpaceKnownGroupKey,
} from "@t2code/contracts/spaces";
import { Trash2Icon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { PropertyPicker } from "../primitives/PropertyPicker";
import { DebouncedInput } from "./DebouncedInput";
import { defaultGroupBy, groupByChoices, isRangeBy, listedBuckets } from "./groupOptions";
import { OptionSelect } from "./OptionSelect";
import { useViewControls } from "./useViewControls";

const ORDERS = [
  { value: "ascending", label: "Ascending" },
  { value: "descending", label: "Descending" },
  { value: "manual", label: "Manual" },
] as const;

const finite = (text: string) =>
  text.trim() !== "" && Number.isFinite(Number(text)) ? Number(text) : null;

export function GroupPopover() {
  const { known, columns, canEditView, actions } = useViewControls();
  const group = known?.group ?? null;
  const groupProperty = group === null ? null : group.property;
  const column = columns.find((entry) => entry.property.id === groupProperty);
  const groupedKnown = column?.known ?? null;
  const subGroupId = known?.subGroup?.property;
  const groupable = columns
    .map((entry) => entry.property)
    .filter(
      (property) =>
        (SPACE_GROUPABLE_TYPES as ReadonlyArray<string>).includes(property.type) &&
        property.id !== subGroupId,
    );
  const commit = (next: SpaceKnownGroup) => actions.editView({ group: next });
  /** Changing the grouping invalidates presentation keyed to the old buckets. */
  const withBy = (current: SpaceKnownGroup, by: SpaceKnownGroupBy | undefined): SpaceKnownGroup => {
    const { order: _order, hidden: _hidden, collapsed: _collapsed, by: _by, ...rest } = current;
    return { ...rest, ...(by === undefined ? {} : { by }) };
  };
  const choices = groupByChoices(groupedKnown?.type ?? "");
  const buckets =
    groupedKnown === null
      ? null
      : listedBuckets(groupedKnown, group === null ? undefined : group.by);
  const hidden = group === null ? [] : (group.hidden ?? []);
  const isHidden = (key: SpaceKnownGroupKey) =>
    hidden.some((entry) => canonicalJson(entry) === canonicalJson(key));
  const range = group !== null && isRangeBy(group.by) ? group.by.range : null;
  return (
    <div className="w-72 max-w-[calc(100vw-2rem)] space-y-2">
      <div className="space-y-1">
        <span className="text-xs text-muted-foreground">Group by</span>
        <PropertyPicker
          label="Group property"
          placeholder="None"
          properties={groupable}
          value={groupProperty}
          disabled={!canEditView}
          onChange={(property) => {
            if (property === group?.property) return;
            const type = groupable.find((entry) => entry.id === property)?.type ?? "";
            const by = defaultGroupBy(type);
            commit({ property, ...(by === undefined ? {} : { by }) });
          }}
        />
      </div>
      {group === null ? null : (
        <>
          {choices.length > 0 ? (
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">Group by variant</span>
              <OptionSelect
                label="Grouping"
                disabled={!canEditView}
                value={choices.find((choice) => choice.by === group.by)?.id ?? null}
                choices={choices.map((choice) => ({ value: choice.id, label: choice.label }))}
                onChange={(id) => {
                  const choice = choices.find((entry) => entry.id === id);
                  if (choice !== undefined) commit(withBy(group, choice.by));
                }}
              />
            </div>
          ) : null}
          {range === null ? null : (
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1 text-xs text-muted-foreground">
                Start
                <DebouncedInput
                  type="number"
                  label="Range start"
                  disabled={!canEditView}
                  value={String(range.start)}
                  onCommit={(text) => {
                    const start = finite(text);
                    if (start !== null) commit(withBy(group, { range: { ...range, start } }));
                  }}
                />
              </label>
              <label className="flex items-center gap-1 text-xs text-muted-foreground">
                Size
                <DebouncedInput
                  type="number"
                  label="Range size"
                  disabled={!canEditView}
                  value={String(range.size)}
                  onCommit={(text) => {
                    const size = finite(text);
                    if (size !== null && size > 0)
                      commit(withBy(group, { range: { ...range, size } }));
                  }}
                />
              </label>
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">Order</span>
            <OptionSelect
              label="Group order"
              disabled={!canEditView}
              value={group.sort ?? "ascending"}
              choices={ORDERS}
              onChange={(sort) => commit({ ...group, sort })}
            />
          </div>
          <label className="flex items-center justify-between gap-2 text-sm">
            Hide empty groups
            <Switch
              size="sm"
              aria-label="Hide empty groups"
              disabled={!canEditView}
              checked={group.hideEmpty === true}
              onCheckedChange={(checked) => commit({ ...group, hideEmpty: checked })}
            />
          </label>
          {buckets === null ? null : (
            <div className="space-y-1 border-t pt-2">
              <span className="text-xs text-muted-foreground">Groups</span>
              {buckets.map((bucket) => (
                <label
                  key={canonicalJson(bucket.key)}
                  className="flex items-center justify-between gap-2 text-sm"
                >
                  <span className="truncate">{bucket.label}</span>
                  <Switch
                    size="sm"
                    aria-label={`Show ${bucket.label}`}
                    disabled={!canEditView}
                    checked={!isHidden(bucket.key)}
                    onCheckedChange={(shown) =>
                      commit({
                        ...group,
                        hidden: shown
                          ? hidden.filter(
                              (entry) => canonicalJson(entry) !== canonicalJson(bucket.key),
                            )
                          : [...hidden, bucket.key],
                      })
                    }
                  />
                </label>
              ))}
            </div>
          )}
          <Button
            variant="ghost-muted"
            size="xs"
            disabled={!canEditView}
            onClick={() => actions.editView({ group: null })}
          >
            <Trash2Icon />
            Remove grouping
          </Button>
        </>
      )}
    </div>
  );
}
