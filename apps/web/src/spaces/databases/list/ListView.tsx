import { canonicalJson } from "@t2code/client-runtime/spaces";
import type { SpacePageId } from "@t2code/contracts/spaces";

import type { GridItem } from "../table/gridItems";

import { useDatabase } from "../shell/context";
import type { DatabaseViewProps } from "../shell/viewTypes";
import { GroupHeader } from "./GroupHeader";
import type { ListLine } from "./ListRow";
import { ListRow } from "./ListRow";
import { buildListLayout, LIST_ROW_HEIGHT } from "./listLayout";
import { RowsError, RowsFooter, RowsLoading } from "./ListStates";
import { AddChildLine, AddLine, MoreChildrenLine, MoreLine, SkeletonLine } from "./RowListItems";
import { useRowList, VIEWER_ZONE } from "./useRowList";
import { WindowScroller } from "./WindowScroller";

/** A neighbour row at the same level: moving past a parent or a child would reparent it. */
const sibling = (item: GridItem | undefined, depth: number | undefined) =>
  item?.kind === "row" && (item.depth ?? 0) === (depth ?? 0);

export default function ListView({ search }: DatabaseViewProps) {
  const { model, view, known, columns, layout: pageLayout, optionHint } = useDatabase();
  const { query, relatedPages, items, handlers, adding, hasData, noRows, manualOrder, labelOf } =
    useRowList(search, columns, { nested: true });
  const { permissions, environmentId } = model;
  const showNames = known?.type === "list" ? known.layout.showPropertyNames !== false : true;
  const lines: ReadonlyArray<ListLine> = columns
    .filter((column) => column.visible && column.property.id !== "title")
    .map((column) => ({ id: column.property.id, known: column.known, name: column.property.name }));
  const listLayout = buildListLayout(items);

  if (query.status === "error" && !hasData)
    return <RowsError query={query} fallback="Couldn't load the rows." />;
  if (!hasData) return <RowsLoading label="Loading rows" height={LIST_ROW_HEIGHT - 4} />;

  const canMove = manualOrder && permissions.rows;
  const renderItem = (index: number) => {
    const item = listLayout.items[index]!;
    const top = listLayout.offsets[index]!;
    switch (item.kind) {
      case "row":
        return (
          <ListRow
            key={item.row.page.id}
            row={item.row}
            lines={lines}
            index={index}
            top={top}
            depth={item.depth ?? 0}
            expandable={item.expandable ?? false}
            expanded={item.expanded ?? false}
            showNames={showNames}
            relatedPages={relatedPages}
            optionHint={optionHint}
            timeZone={VIEWER_ZONE}
            environmentId={environmentId}
            spaceId={model.database.spaceId}
            handlers={handlers}
            canTrash={permissions.rows}
            canMoveUp={canMove && sibling(listLayout.items[index - 1], item.depth)}
            canMoveDown={canMove && sibling(listLayout.items[index + 1], item.depth)}
          />
        );
      case "addChild":
        return (
          <AddChildLine
            key={`ac:${item.parentId}`}
            index={index}
            top={top}
            parentId={item.parentId as SpacePageId}
            depth={item.depth}
            handlers={handlers}
          />
        );
      case "moreChildren":
        return (
          <MoreChildrenLine
            key={`mc:${item.parentId}`}
            index={index}
            top={top}
            parentId={item.parentId as SpacePageId}
            depth={item.depth}
            loading={item.loading}
            handlers={handlers}
          />
        );
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
      case "add":
        return (
          <AddLine
            key={`add:${index}`}
            index={index}
            top={top}
            group={item.group}
            adding={adding === (item.group === null ? "" : canonicalJson(item.group))}
            handlers={handlers}
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
      case "skeleton":
        return <SkeletonLine key={`s:${index}`} index={index} top={top} />;
    }
  };

  return (
    <WindowScroller
      plan={() => listLayout}
      render={renderItem}
      label="Rows"
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
