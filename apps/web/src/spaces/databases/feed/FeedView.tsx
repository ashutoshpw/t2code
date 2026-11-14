import { feedPreviewBlocks, feedWindowLimit } from "@t2code/client-runtime/spaces";
import { useLayoutEffect, useState } from "react";
import type { SpacePageId } from "@t2code/contracts/spaces";

import { Latest } from "../data/latest";
import { useViewQuery } from "../data/useViewQuery";
import { RowsError, RowsFooter, RowsLoading } from "../list/ListStates";
import { VIEWER_ZONE } from "../list/useRowList";
import { WindowScroller } from "../list/WindowScroller";
import { useDatabase, useDatabaseActions } from "../shell/context";
import type { DatabaseViewProps } from "../shell/viewTypes";
import { FeedCard } from "./FeedCard";
import { FEED_PROPERTY_LIMIT, feedPlan } from "./feedLayout";

export default function FeedView({ search }: DatabaseViewProps) {
  const { model, view, columns, layout: pageLayout, optionHint } = useDatabase();
  const actions = useDatabaseActions();
  const blocks = feedPreviewBlocks(view);
  const query = useViewQuery(view, columns, {
    mode: "rows",
    search,
    ...(blocks > 0 ? { preview: blocks } : {}),
    limit: feedWindowLimit(view, model.limits.maxQueryRows),
  });
  const lines = columns
    .filter((column) => column.visible && column.property.id !== "title")
    .slice(0, FEED_PROPERTY_LIMIT)
    .map((column) => ({ id: column.property.id, known: column.known, name: column.property.name }));
  const [latest] = useState(() => new Latest<(pageId: SpacePageId) => void>(() => {}));
  const [open] = useState(() => (pageId: SpacePageId) => latest.get()(pageId));
  // oxlint-disable-next-line t2code/no-unreasoned-state-sync -- Point the stable open handler at the latest actions so memoized cards keep their props.
  useLayoutEffect(() => {
    latest.set((pageId) => actions.openRow(pageId));
  });

  const hasData = query.rows.length > 0 || query.status === "ready";
  if (query.status === "error" && !hasData)
    return <RowsError query={query} fallback="Couldn't load the rows." />;
  if (!hasData) return <RowsLoading label="Loading rows" height={88} />;

  const rows = query.rows;
  const noRows = query.status === "ready" && !query.hasMore && rows.length === 0;
  return (
    <WindowScroller
      plan={() => feedPlan(rows.length, blocks)}
      render={(index, plan) => {
        const row = rows[index]!;
        return (
          <FeedCard
            key={row.page.id}
            row={row}
            lines={lines}
            index={index}
            top={plan.offsets[index]!}
            height={plan.height}
            relatedPages={query.relatedPages}
            optionHint={optionHint}
            timeZone={VIEWER_ZONE}
            onOpen={open}
          />
        );
      }}
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
                : "No rows"
              : null
          }
        />
      }
    />
  );
}
