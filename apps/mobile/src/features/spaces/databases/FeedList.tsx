import { LegendList } from "@legendapp/list/react-native";
import { viewDependencies, type CellTextContext } from "@t2code/client-runtime/spaces";
import type { EnvironmentId } from "@t2code/contracts";
import type {
  SpaceDataSource,
  SpaceDatabaseRow,
  SpaceDatabaseView,
} from "@t2code/contracts/spaces";
import type { ReactElement } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { ControlPill } from "../../../components/ui/ControlPill";
import { NativeScrollView } from "../../../native/NativeScrollViewMarker";
import { viewerZone } from "../../../state/spacesDatabases";
import { CellValueView } from "./CellValueView";
import { cardLines, rowDisplayTitle } from "./cellText";
import { feedColumns, feedQueryInput, previewLines } from "./feedItems";
import type { DatabaseModel } from "./useDatabaseModel";
import { useViewRows } from "./useViewRows";
import { canLoadMore } from "./viewForms";

const noHint: CellTextContext["optionHint"] = () => undefined;

function FeedCard(props: {
  readonly row: SpaceDatabaseRow;
  readonly columns: ReturnType<typeof feedColumns>;
  readonly context: CellTextContext;
  readonly onOpen: (row: SpaceDatabaseRow) => void;
}) {
  const { row } = props;
  const title = rowDisplayTitle(row);
  const lines = cardLines(row, props.columns, props.context);
  const body = previewLines(row.preview);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      className="mx-4 mb-2 gap-1 rounded-2xl border border-border bg-grouped-card px-3.5 py-3"
      onPress={() => props.onOpen(row)}
    >
      <Text className="text-base font-semibold text-foreground" numberOfLines={2}>
        {row.page.icon ? `${row.page.icon} ` : ""}
        {title}
      </Text>
      {lines.map((line) => (
        <View key={line.propertyId} className="flex-row flex-wrap items-center gap-x-2 gap-y-1">
          <Text className="text-sm text-foreground-muted">{line.name}</Text>
          <CellValueView line={line} numberOfLines={2} />
        </View>
      ))}
      {body.length === 0 ? null : (
        <Text className="text-sm text-foreground" numberOfLines={2 * body.length}>
          {body.join("\n")}
        </Text>
      )}
      {row.preview?.more === true ? <Text className="text-sm text-foreground-muted">…</Text> : null}
    </Pressable>
  );
}

/**
 * A read-only feed: each row as a card with its title, a few properties and the first blocks of its
 * page. `windowed` is the full screen (a virtualised list that loads more); otherwise the first
 * `maxCards` cards, for a block inside a page.
 */
export function FeedList(props: {
  readonly environmentId: EnvironmentId;
  readonly model: DatabaseModel;
  readonly view: SpaceDatabaseView;
  readonly dataSource: SpaceDataSource;
  readonly onOpenRow: (row: SpaceDatabaseRow) => void;
  readonly maxCards: number;
  readonly header?: ReactElement;
  readonly windowed?: boolean;
}) {
  const { view, dataSource, environmentId } = props;
  const input = feedQueryInput(view, dataSource, {
    environmentId,
    timeZone: viewerZone(),
    maxQueryRows: props.model.limits.maxQueryRows,
  });
  const watch = viewDependencies(view, undefined, dataSource, input.properties ?? []);
  const rows = useViewRows(environmentId, dataSource.id, input, watch);
  const columns = feedColumns(view, dataSource);
  const context: CellTextContext = {
    relatedPages: rows.relatedPages,
    optionHint: noHint,
    timeZone: viewerZone(),
  };
  const status =
    rows.error !== null ? (
      <View className="items-start gap-2 px-4 py-2">
        <Text className="text-base text-foreground-muted">{rows.error}</Text>
        <ControlPill variant="pill" label="Retry" onPress={rows.retry} />
      </View>
    ) : rows.status === "loading" && rows.rows.length === 0 ? (
      <Text className="px-4 py-2 text-base text-foreground-muted">Loading rows…</Text>
    ) : rows.rows.length === 0 ? (
      <Text className="px-4 py-2 text-base text-foreground-muted">No rows.</Text>
    ) : null;
  if (props.windowed === true)
    return (
      <LegendList
        renderScrollComponent={NativeScrollView}
        className="flex-1"
        contentContainerStyle={{ paddingBottom: 32 }}
        data={rows.rows}
        estimatedItemSize={160}
        keyExtractor={(row) => row.page.id}
        recycleItems
        onEndReachedThreshold={0.5}
        onEndReached={() => {
          if (canLoadMore(rows.rows.length, rows.hasMore)) rows.loadMore();
        }}
        ListHeaderComponent={props.header}
        ListEmptyComponent={status}
        ListFooterComponent={
          rows.loadingMore ? (
            <Text className="px-4 py-3 text-sm text-foreground-muted">Loading more rows…</Text>
          ) : null
        }
        renderItem={({ item }) => (
          <FeedCard row={item} columns={columns} context={context} onOpen={props.onOpenRow} />
        )}
      />
    );
  return (
    <View>
      {status ??
        rows.rows
          .slice(0, props.maxCards)
          .map((row) => (
            <FeedCard
              key={row.page.id}
              row={row}
              columns={columns}
              context={context}
              onOpen={props.onOpenRow}
            />
          ))}
    </View>
  );
}
