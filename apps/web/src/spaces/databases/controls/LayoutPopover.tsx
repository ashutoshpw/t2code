import type { ReactNode } from "react";

import { BoardLayoutSection } from "../board/BoardLayoutSection";
import { CalendarLayoutSection } from "../calendar/CalendarLayoutSection";
import { ChartLayoutSection } from "../chart/ChartLayoutSection";
import { FeedLayoutSection } from "../feed/FeedLayoutSection";
import { FormLayoutSection } from "../form/FormLayoutSection";
import { GalleryLayoutSection } from "../gallery/GalleryLayoutSection";
import { ListLayoutSection } from "../list/ListLayoutSection";
import type { LayoutSectionProps } from "../shell/layoutSection";
import { TableLayoutSection } from "../table/TableLayoutSection";
import { TimelineLayoutSection } from "../timeline/TimelineLayoutSection";
import { useViewControls } from "./useViewControls";

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
    case "chart":
      return <ChartLayoutSection {...props} />;
    case "form":
      return <FormLayoutSection {...props} />;
    case "feed":
      return <FeedLayoutSection {...props} />;
    default:
      return null;
  }
}

/** The settings of the active view's type. */
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
    </div>
  );
}
