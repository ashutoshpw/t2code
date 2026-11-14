import { Switch } from "~/components/ui/switch";
import { LayoutRow, type LayoutSectionProps } from "../shell/layoutSection";

export function ListLayoutSection({ known, editView, disabled }: LayoutSectionProps) {
  if (known?.type !== "list") return null;
  return (
    <LayoutRow label="Show property names">
      <Switch
        size="sm"
        aria-label="Show property names"
        checked={known.layout.showPropertyNames !== false}
        disabled={disabled}
        onCheckedChange={(showPropertyNames) =>
          editView({ layout: { ...known.layout, showPropertyNames } })
        }
      />
    </LayoutRow>
  );
}
