import {
  feedPreviewBlocks,
  feedWindowLimit,
  viewColumns,
  viewQueryInput,
} from "@t2code/client-runtime/spaces";
import type { EnvironmentId } from "@t2code/contracts";
import {
  SPACE_TITLE_PROPERTY_ID,
  SpacePropertyId,
  type SpaceDataSource,
  type SpaceDatabaseQueryInput,
  type SpaceDatabaseRow,
  type SpaceDatabaseView,
} from "@t2code/contracts/spaces";

const FEED_PROPERTIES = 3;
const humanize = (type: string): string =>
  `${type.charAt(0).toUpperCase()}${type.slice(1).replaceAll("_", " ")}`;

/** The visible properties a feed card shows besides the title. */
export function feedColumns(view: SpaceDatabaseView, dataSource: SpaceDataSource) {
  return viewColumns(view, dataSource)
    .filter((column) => column.visible && column.property.id !== SPACE_TITLE_PROPERTY_ID)
    .slice(0, FEED_PROPERTIES);
}

export function feedQueryInput(
  view: SpaceDatabaseView,
  dataSource: SpaceDataSource,
  options: {
    readonly environmentId: EnvironmentId;
    readonly timeZone: string;
    readonly maxQueryRows: number;
  },
): SpaceDatabaseQueryInput {
  const preview = feedPreviewBlocks(view);
  const ids: ReadonlyArray<SpacePropertyId> = feedColumns(view, dataSource).map(
    (column) => column.property.id,
  );
  return viewQueryInput(view, {
    environmentId: options.environmentId,
    mode: "rows",
    timeZone: options.timeZone,
    limit: feedWindowLimit(view, options.maxQueryRows),
    visiblePropertyIds: [SpacePropertyId.make(SPACE_TITLE_PROPERTY_ID), ...ids],
    includeAggregates: false,
    ...(preview === 0 ? {} : { preview }),
  });
}

/** Plain-text lines for a card's body preview; a block without text reads as its label. */
export function previewLines(preview: SpaceDatabaseRow["preview"]): ReadonlyArray<string> {
  if (preview === undefined) return [];
  return preview.blocks.flatMap((block) => {
    const text = block.runs
      .map((run) => run.text)
      .join("")
      .trim();
    if (text !== "")
      return [block.type === "todo_item" ? `${block.checked === true ? "☑" : "☐"} ${text}` : text];
    return block.type === "divider" ? [] : [humanize(block.type)];
  });
}
