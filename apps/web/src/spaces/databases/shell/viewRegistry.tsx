import {
  CalendarIcon,
  ColumnsIcon,
  GalleryVerticalIcon,
  GanttChartIcon,
  ListIcon,
  TableIcon,
  type LucideIcon,
} from "lucide-react";
import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import { VIEW_TYPE_NAMES } from "@t2code/client-runtime/spaces";
import { SPACE_VIEW_TYPES, type SpaceViewType } from "@t2code/contracts/spaces";

import type { DatabaseViewProps } from "./viewTypes";

interface ViewEntry {
  readonly label: string;
  readonly icon: LucideIcon;
  readonly Body: LazyExoticComponent<ComponentType<DatabaseViewProps>>;
}

/** The one place a view type is wired: tabs, the add and type menus and the body read it. */
export const VIEW_REGISTRY: Readonly<Record<SpaceViewType, ViewEntry>> = {
  table: {
    label: VIEW_TYPE_NAMES.table,
    icon: TableIcon,
    Body: lazy(() => import("../table/TableView")),
  },
  board: {
    label: VIEW_TYPE_NAMES.board,
    icon: ColumnsIcon,
    Body: lazy(() => import("../board/BoardView")),
  },
  list: {
    label: VIEW_TYPE_NAMES.list,
    icon: ListIcon,
    Body: lazy(() => import("../list/ListView")),
  },
  gallery: {
    label: VIEW_TYPE_NAMES.gallery,
    icon: GalleryVerticalIcon,
    Body: lazy(() => import("../gallery/GalleryView")),
  },
  calendar: {
    label: VIEW_TYPE_NAMES.calendar,
    icon: CalendarIcon,
    Body: lazy(() => import("../calendar/CalendarView")),
  },
  timeline: {
    label: VIEW_TYPE_NAMES.timeline,
    icon: GanttChartIcon,
    Body: lazy(() => import("../timeline/TimelineView")),
  },
};

export const VIEW_TYPES: ReadonlyArray<SpaceViewType> = SPACE_VIEW_TYPES;

/** The registry entry for a type this client knows; undefined for a future type. */
export const viewEntry = (type: string): ViewEntry | undefined => {
  const known = VIEW_TYPES.find((candidate) => candidate === type);
  return known === undefined ? undefined : VIEW_REGISTRY[known];
};
