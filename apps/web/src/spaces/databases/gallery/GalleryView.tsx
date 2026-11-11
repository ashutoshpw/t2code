import { canonicalJson } from "@t2code/client-runtime/spaces";

import { GroupHeader } from "../list/GroupHeader";
import { RowsError, RowsFooter, RowsLoading } from "../list/ListStates";
import { MoreLine } from "../list/RowListItems";
import { useRowList, VIEWER_ZONE } from "../list/useRowList";
import { WindowScroller } from "../list/WindowScroller";
import { useDatabase } from "../shell/context";
import type { DatabaseViewProps } from "../shell/viewTypes";
import { AddCard, GalleryCard, SkeletonCard } from "./GalleryCard";
import { coverPropertyId, withForcedColumns } from "./galleryColumns";
import {
  buildGalleryLayout,
  cardHeight,
  CARD_GAP,
  CARD_PADDING,
  columnsFor,
  coverHeight,
  type CardSize,
} from "./galleryLayout";

export default function GalleryView({ search }: DatabaseViewProps) {
  const { model, view, known, columns, layout: pageLayout, optionHint } = useDatabase();
  const config = known?.type === "gallery" ? known.layout : {};
  const size: CardSize = config.cardSize ?? "medium";
  const preview = config.cardPreview;
  const fit = config.fitImage === true;
  const coverId = coverPropertyId(preview, columns);
  const hasCover = coverId !== null || preview?.kind === "page_content";
  const { query, items, handlers, adding, hasData, noRows, manualOrder, labelOf } = useRowList(
    search,
    withForcedColumns(columns, coverId === null ? [] : [coverId]),
    { cover: preview?.kind === "page_content" },
  );
  const { permissions, environmentId } = model;
  const lines = columns
    .filter((column) => column.visible && column.property.id !== "title")
    .map((column) => ({ id: column.property.id, known: column.known }));
  const height = cardHeight(size, hasCover, lines.length);

  if (query.status === "error" && !hasData)
    return <RowsError query={query} fallback="Couldn't load the cards." />;
  if (!hasData) return <RowsLoading label="Loading cards" height={48} />;

  const canMove = manualOrder && permissions.rows;
  const movable = new Map<string, { up: boolean; down: boolean }>();
  items.forEach((item, at) => {
    if (item.kind === "row")
      movable.set(item.row.page.id, {
        up: canMove && items[at - 1]?.kind === "row",
        down: canMove && items[at + 1]?.kind === "row",
      });
  });

  const renderItem = (index: number, plan: ReturnType<typeof buildGalleryLayout>) => {
    const item = plan.items[index]!;
    const top = plan.offsets[index]!;
    switch (item.kind) {
      case "group":
        return (
          <GroupHeader
            key={`g:${item.id}`}
            id={item.id}
            index={index}
            top={top}
            bucket={item.bucket}
            label={labelOf(item.bucket)}
            collapsed={item.collapsed}
            onToggle={handlers.toggleGroup}
          />
        );
      case "more":
        return (
          <MoreLine
            key={`more:${index}`}
            index={index}
            top={top}
            group={item.group}
            loading={item.loading}
            handlers={handlers}
          />
        );
      case "cards":
        return (
          <div
            key={`c:${index}`}
            role="presentation"
            data-item-index={index}
            className="absolute grid"
            style={{
              top,
              height,
              insetInline: CARD_PADDING,
              gap: CARD_GAP,
              gridTemplateColumns: `repeat(${plan.columns}, minmax(0, 1fr))`,
            }}
          >
            {item.cells.map((cell, at) => {
              if (cell.kind === "row")
                return (
                  <GalleryCard
                    key={cell.row.page.id}
                    row={cell.row}
                    lines={lines}
                    relatedPages={query.relatedPages}
                    optionHint={optionHint}
                    timeZone={VIEWER_ZONE}
                    preview={preview}
                    coverHeight={coverHeight(size, hasCover)}
                    fit={fit}
                    environmentId={environmentId}
                    spaceId={model.database.spaceId}
                    handlers={handlers}
                    canTrash={permissions.rows}
                    canMoveUp={movable.get(cell.row.page.id)?.up ?? false}
                    canMoveDown={movable.get(cell.row.page.id)?.down ?? false}
                  />
                );
              if (cell.kind === "add")
                return (
                  <AddCard
                    key="add"
                    adding={adding === (cell.group === null ? "" : canonicalJson(cell.group))}
                    onAdd={() => handlers.add(cell.group)}
                  />
                );
              // oxlint-disable-next-line react/no-array-index-key -- Skeleton placeholders have no identity.
              return <SkeletonCard key={`s:${at}`} />;
            })}
          </div>
        );
    }
  };

  return (
    <WindowScroller
      plan={(width) =>
        buildGalleryLayout({
          items,
          columns: columnsFor(width - 2 * CARD_PADDING, size),
          cardHeight: height,
        })
      }
      render={renderItem}
      label="Cards"
      busy={query.stale}
      pageLayout={pageLayout}
      onNearEnd={() => {
        if (query.hasMore && !query.loadingMore && query.loadError === null) query.loadMore();
      }}
      below={
        <RowsFooter
          query={query}
          empty={
            noRows
              ? view.filter !== undefined || search !== ""
                ? "Nothing matches this view"
                : "No rows yet"
              : null
          }
        />
      }
    />
  );
}
