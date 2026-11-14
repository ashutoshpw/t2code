import { Button } from "~/components/ui/button";
import { useDatabase, useDatabaseActions } from "../shell/context";
import { LayoutRow, type LayoutSectionProps } from "../shell/layoutSection";
import { OptionSelect } from "./OptionSelect";

const MODES = [
  { value: "nested", label: "Show in hierarchy" },
  { value: "flattened", label: "Show as rows" },
] as const;

/** Sub-items of the data source: turn them on or off, and how this view draws them. */
export function SubItemsSection({ known, editView, disabled }: LayoutSectionProps) {
  const { dataSource, model } = useDatabase();
  const actions = useDatabaseActions();
  if (known === null) return null;
  const canSchema = model.permissions.schema;
  const mode = known.layout.subItems === "flattened" ? "flattened" : "nested";
  if (dataSource.subItems === undefined)
    return (
      <LayoutRow label="Sub-items">
        <Button
          size="xs"
          variant="outline"
          disabled={!canSchema}
          onClick={() => void actions.setSubItems(true)}
        >
          Turn on sub-items
        </Button>
      </LayoutRow>
    );
  return (
    <>
      <LayoutRow label="Sub-items">
        <OptionSelect
          label="Sub-items"
          value={mode}
          choices={MODES}
          disabled={disabled}
          onChange={(subItems) => editView({ layout: { ...known.layout, subItems } })}
        />
      </LayoutRow>
      <LayoutRow label="Sub-items are on">
        <Button
          size="xs"
          variant="ghost"
          disabled={!canSchema}
          onClick={() => void actions.setSubItems(false)}
        >
          Turn off
        </Button>
      </LayoutRow>
    </>
  );
}
