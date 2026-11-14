import { Switch } from "~/components/ui/switch";
import { SubItemsSection } from "../controls/SubItemsSection";
import { LayoutRow, type LayoutSectionProps } from "../shell/layoutSection";

export function TableLayoutSection(props: LayoutSectionProps) {
  const { known, editView, disabled } = props;
  if (known?.type !== "table") return null;
  return (
    <>
      <LayoutRow label="Wrap all cells">
        <Switch
          size="sm"
          aria-label="Wrap all cells"
          checked={known.layout.wrapCells === true}
          disabled={disabled}
          onCheckedChange={(wrapCells) => editView({ layout: { ...known.layout, wrapCells } })}
        />
      </LayoutRow>
      <SubItemsSection {...props} />
    </>
  );
}
