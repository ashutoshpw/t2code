import { Switch } from "~/components/ui/switch";
import { LayoutRow, type LayoutSectionProps } from "../shell/layoutSection";

export function TableLayoutSection({ known, editView, disabled }: LayoutSectionProps) {
  if (known?.type !== "table") return null;
  return (
    <LayoutRow label="Wrap all cells">
      <Switch
        size="sm"
        aria-label="Wrap all cells"
        checked={known.layout.wrapCells === true}
        disabled={disabled}
        onCheckedChange={(wrapCells) => editView({ layout: { ...known.layout, wrapCells } })}
      />
    </LayoutRow>
  );
}
