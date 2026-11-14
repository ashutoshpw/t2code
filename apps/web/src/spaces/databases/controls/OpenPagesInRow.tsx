import { LayoutRow } from "../shell/layoutSection";
import { OptionSelect } from "./OptionSelect";
import { useViewControls } from "./useViewControls";

const OPEN_PAGES = [
  { value: "side_peek", label: "Side peek" },
  { value: "center_peek", label: "Center peek" },
  { value: "full_page", label: "Full page" },
] as const;

/** How rows of the active view open when clicked. */
export function OpenPagesInRow() {
  const { known, canEditView, actions } = useViewControls();
  if (known === null) return null;
  return (
    <LayoutRow label="Open pages in">
      <OptionSelect
        label="Open pages in"
        value={known.layout.openPagesIn ?? "side_peek"}
        disabled={!canEditView}
        choices={OPEN_PAGES}
        onChange={(openPagesIn) => actions.editView({ layout: { ...known.layout, openPagesIn } })}
      />
    </LayoutRow>
  );
}
