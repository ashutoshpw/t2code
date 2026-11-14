import type { ReactNode } from "react";

import { BoardLayoutSection } from "../board/BoardLayoutSection";
import { CalendarLayoutSection } from "../calendar/CalendarLayoutSection";
import { GalleryLayoutSection } from "../gallery/GalleryLayoutSection";
import { ListLayoutSection } from "../list/ListLayoutSection";
import { LayoutRow, type LayoutSectionProps } from "../shell/layoutSection";
import { TableLayoutSection } from "../table/TableLayoutSection";
import { TimelineLayoutSection } from "../timeline/TimelineLayoutSection";
import { OptionSelect } from "./OptionSelect";
import { useViewControls } from "./useViewControls";

type OpenPagesIn = "side_peek" | "center_peek" | "full_page";
const OPEN_PAGES: ReadonlyArray<{ value: OpenPagesIn; label: string }> = [
  { value: "side_peek", label: "Side peek" },
  { value: "center_peek", label: "Center peek" },
  { value: "full_page", label: "Full page" },
];

/** The section of the view's type; table and board have no type-specific setting yet. */
function TypeSection(props: LayoutSectionProps): ReactNode {
  switch (props.known?.type) {
    case "table":
      return <TableLayoutSection {...props} />;
    case "board":
      return <BoardLayoutSection {...props} />;
    case "list":
      return <ListLayoutSection {...props} />;
    case "gallery":
      return <GalleryLayoutSection {...props} />;
    case "calendar":
      return <CalendarLayoutSection {...props} />;
    case "timeline":
      return <TimelineLayoutSection {...props} />;
    default:
      return null;
  }
}

/** Layout of the active view: its type's settings, then how rows open. */
export function LayoutPopover() {
  const { view, known, dataSource, canEditView, actions } = useViewControls();
  if (known === null) return null;
  const props: LayoutSectionProps = {
    view,
    known,
    dataSource,
    editView: actions.editView,
    disabled: !canEditView,
  };
  return (
    <div className="w-72 max-w-[calc(100vw-2rem)] space-y-1">
      <TypeSection {...props} />
      <LayoutRow label="Open pages in">
        <OptionSelect
          label="Open pages in"
          value={known.layout.openPagesIn ?? "side_peek"}
          disabled={!canEditView}
          choices={OPEN_PAGES}
          onChange={(openPagesIn) => actions.editView({ layout: { ...known.layout, openPagesIn } })}
        />
      </LayoutRow>
    </div>
  );
}
