import type {
  SpaceSharedDataSource,
  SpaceSharedDatabaseView,
  SpaceSharedGroupBucket,
} from "@t2code/contracts";
import {
  SpaceCardPreview,
  type SpaceDatabaseProperty,
  type SpaceGroupKey,
} from "@t2code/contracts/spaces";
import * as Schema from "effect/Schema";

import { bucketId } from "./paging";

const VIEW_TYPES = ["table", "board", "list", "gallery", "calendar", "timeline"] as const;
export type ViewType = (typeof VIEW_TYPES)[number];
export const isViewType = (type: string): type is ViewType =>
  (VIEW_TYPES as ReadonlyArray<string>).includes(type);

export interface ViewColumn {
  readonly property: SpaceDatabaseProperty;
  readonly width: number | undefined;
  readonly wrap: boolean;
}

export interface ViewModel {
  readonly columns: ReadonlyArray<ViewColumn>;
  readonly cardPreview: SpaceCardPreview | undefined;
  readonly cardSize: "small" | "medium" | "large";
  readonly fitImage: boolean;
  readonly showPropertyNames: boolean;
  readonly wrapCells: boolean;
  readonly weekStart: "sunday" | "monday";
  /** Calendar date property, or the timeline start. */
  readonly startId: string | undefined;
  readonly endId: string | undefined;
}

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};

const isPreview = Schema.is(SpaceCardPreview);

const flag = (value: unknown) => value === true;

export function viewModel(view: SpaceSharedDatabaseView, source: SpaceSharedDataSource): ViewModel {
  const layout = record(view.layout);
  const size = layout.cardSize;
  const start = layout.startPropertyId ?? layout.datePropertyId;
  const end = layout.endPropertyId;
  return {
    columns: view.properties.flatMap((entry) => {
      const property = source.properties[entry.propertyId];
      return property === undefined
        ? []
        : [{ property, width: entry.width, wrap: entry.wrap === true }];
    }),
    cardPreview: isPreview(layout.cardPreview) ? layout.cardPreview : undefined,
    cardSize: size === "small" || size === "large" ? size : "medium",
    fitImage: flag(layout.fitImage),
    showPropertyNames: flag(layout.showPropertyNames),
    wrapCells: flag(layout.wrapCells),
    weekStart: layout.weekStart === "monday" ? "monday" : "sunday",
    startId: typeof start === "string" ? start : undefined,
    endId: typeof end === "string" ? end : undefined,
  };
}

/** Buckets in `group.order` first (server order for the rest). */
export function orderBuckets(
  buckets: ReadonlyArray<SpaceSharedGroupBucket>,
  order: ReadonlyArray<SpaceGroupKey> | undefined,
): ReadonlyArray<SpaceSharedGroupBucket> {
  if (order === undefined || order.length === 0) return buckets;
  const rank = new Map(order.map((key, index) => [JSON.stringify(key), index]));
  return buckets
    .map((bucket, index) => ({ bucket, index }))
    .toSorted(
      (a, b) =>
        (rank.get(bucketId(a.bucket)) ?? order.length) -
          (rank.get(bucketId(b.bucket)) ?? order.length) || a.index - b.index,
    )
    .map((entry) => entry.bucket);
}
