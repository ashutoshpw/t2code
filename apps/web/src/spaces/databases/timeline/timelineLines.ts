import type { SpaceDatabaseRow, SpaceGroupBucket, SpaceGroupKey } from "@t2code/contracts/spaces";

import type { GridItem } from "../table/gridItems";

/** One fixed-height line of the timeline body: a row, a group header or a bucket's `Load more`. */
export type TimelineLine =
  | { readonly kind: "row"; readonly row: SpaceDatabaseRow }
  | {
      readonly kind: "group";
      readonly id: string;
      readonly bucket: SpaceGroupBucket;
      readonly collapsed: boolean;
    }
  | { readonly kind: "more"; readonly group: SpaceGroupKey; readonly loading: boolean };

/** The grid items a timeline draws: no add lines and no loading skeletons. */
export function timelineLines(items: ReadonlyArray<GridItem>): ReadonlyArray<TimelineLine> {
  return items.flatMap((item): TimelineLine[] => {
    switch (item.kind) {
      case "row":
        return [{ kind: "row", row: item.row }];
      case "group":
        return [{ kind: "group", id: item.id, bucket: item.bucket, collapsed: item.collapsed }];
      case "more":
        return [{ kind: "more", group: item.group, loading: item.loading }];
      default:
        return [];
    }
  });
}

export interface TimelineGroupHandlers {
  toggle(id: string): void;
  loadBucket(key: SpaceGroupKey): void;
}
