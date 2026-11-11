import { Switch } from "~/components/ui/switch";
import { SubItemsSection } from "../controls/SubItemsSection";
import { LayoutRow, type LayoutSectionProps } from "../shell/layoutSection";

export function ListLayoutSection(props: LayoutSectionProps) {
  const { known, editView, disabled } = props;
  if (known?.type !== "list") return null;
  return (
    <>
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
      <SubItemsSection {...props} />
    </>
  );
}
