import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { LegendList } from "@legendapp/list/react-native";
import { canBrowseSpaces } from "@t2code/client-runtime/state/spaces";
import { isSpaceDatabaseBlock, resolveBlockViews } from "@t2code/client-runtime/spaces";
import type { EnvironmentId } from "@t2code/contracts";
import type {
  SpaceBlockId,
  SpaceDatabaseId,
  SpaceDatabaseRow,
  SpaceGroupKey,
  SpaceId,
  SpacePageId,
  SpaceViewId,
} from "@t2code/contracts/spaces";
import { useEffect, useState, useSyncExternalStore } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { ControlPill } from "../../../components/ui/ControlPill";
import { NativeScrollView } from "../../../native/NativeScrollViewMarker";
import { SettingsScreen } from "../../settings/components/SettingsScreen";
import { acquireSpacesPageReader, useSpacesReadAccess } from "../../../state/spaces";
import { viewerZone } from "../../../state/spacesDatabases";
import type { SpacesReadAccess } from "../readAccess";
import { AccessNotice, Notice } from "../spacesScreenSupport";
import { monthOfNow, stepMonth } from "./agenda";
import { AgendaHeader } from "./AgendaHeader";
import { DATABASES_NEED_NEWER_SERVER, databaseLimitsOf } from "./capability";
import { DatabaseListItem } from "./DatabaseViewList";
import { canAddToGroup } from "./addRow";
import { NewRowPill } from "./NewRowPill";
import { NewRowSheet } from "./NewRowSheet";
import { WriteNotices } from "./WriteNotices";
import { DEAD_DATABASE_MESSAGE } from "./SpacesDatabaseBlock";
import { readSpacesDatabaseTarget, type SpacesDatabaseTarget } from "./navigation";
import { useDatabaseModel, type DatabaseModel } from "./useDatabaseModel";
import { useViewContent } from "./useViewContent";
import { ViewSwitcher } from "./ViewSwitcher";
import { canLoadMore, viewSummary } from "./viewForms";

type Params = {
  readonly environmentId: EnvironmentId;
  readonly spaceId: SpaceId;
  readonly pageId: SpacePageId;
  readonly blockId: SpaceBlockId;
  readonly viewId?: SpaceViewId;
  readonly databaseId?: SpaceDatabaseId;
  readonly viewIds?: ReadonlyArray<SpaceViewId>;
};

export function SpacesDatabaseRouteScreen({ route }: StaticScreenProps<Params>) {
  const target = readSpacesDatabaseTarget(route.params);
  return (
    <SettingsScreen title="Database">
      {target ? (
        <ScreenSource key={JSON.stringify(route.params)} target={target} />
      ) : (
        <Notice>This Spaces link is invalid.</Notice>
      )}
    </SettingsScreen>
  );
}

function ScreenSource({ target }: { target: SpacesDatabaseTarget }) {
  const access = useSpacesReadAccess(target.environmentId);
  if (!canBrowseSpaces(access.availability))
    return <AccessNotice access={access} environmentId={target.environmentId} />;
  if (databaseLimitsOf(access.capability) === null)
    return <Notice>{DATABASES_NEED_NEWER_SERVER}</Notice>;
  return target.block ? (
    <DatabaseSource target={target} block={target.block} access={access} />
  ) : (
    <LinkedSource target={target} access={access} />
  );
}

type PageLease = Awaited<ReturnType<typeof acquireSpacesPageReader>>;

/** Opened by a link: the block's database and views come from the page's first window. */
function LinkedSource(props: { target: SpacesDatabaseTarget; access: SpacesReadAccess }) {
  const { target, access } = props;
  const [state, setState] = useState<{ lease: PageLease | null; error: string | null } | null>(
    null,
  );
  // oxlint-disable-next-line t2code/no-unreasoned-state-sync -- Hold the shared page reader lease for this screen and release it when the screen or the connection goes away.
  useEffect(() => {
    const abort = new AbortController();
    let acquired: PageLease | null = null;
    void acquireSpacesPageReader(
      { environmentId: target.environmentId, spaceId: target.spaceId, pageId: target.pageId },
      access,
      abort.signal,
    ).then(
      (lease) => {
        if (abort.signal.aborted) lease.release();
        else {
          acquired = lease;
          setState({ lease, error: null });
        }
      },
      (cause: unknown) => {
        if (!abort.signal.aborted)
          setState({
            lease: null,
            error: cause instanceof Error ? cause.message : "Could not open this page.",
          });
      },
    );
    return () => {
      abort.abort();
      acquired?.release();
    };
  }, [target.environmentId, target.spaceId, target.pageId, access]);
  if (state === null) return <Notice>Opening database…</Notice>;
  if (state.lease === null) return <Notice>{state.error ?? "Could not open this page."}</Notice>;
  return <LeasedBlock lease={state.lease} target={target} access={access} />;
}

function LeasedBlock(props: {
  lease: PageLease;
  target: SpacesDatabaseTarget;
  access: SpacesReadAccess;
}) {
  const { reader } = props.lease;
  const snapshot = useSyncExternalStore(reader.subscribe, reader.getSnapshot);
  const block = snapshot.session.blocks.find((entry) => entry.id === props.target.blockId);
  if (block !== undefined && isSpaceDatabaseBlock(block))
    return (
      <DatabaseSource
        target={props.target}
        block={{ databaseId: block.content.databaseId, viewIds: block.content.viewIds }}
        access={props.access}
      />
    );
  if (snapshot.error !== null) return <Notice>{snapshot.error}</Notice>;
  if (snapshot.loading || !snapshot.session.hydrated || snapshot.window === null)
    return <Notice>Opening database…</Notice>;
  return (
    <Notice>
      {snapshot.window.nextCursor !== null
        ? "This database is not in the first part of its page. Open the page to find it."
        : "This database is not on this page any more."}
    </Notice>
  );
}

function DatabaseSource(props: {
  target: SpacesDatabaseTarget;
  block: NonNullable<SpacesDatabaseTarget["block"]>;
  access: SpacesReadAccess;
}) {
  const { target, block } = props;
  const { model, isPending, error, refresh } = useDatabaseModel(
    target.environmentId,
    block.databaseId,
  );
  if (model === null)
    return (
      <View className="gap-2">
        <Notice>
          {isPending ? "Loading database…" : (error ?? "This database could not be loaded.")}
        </Notice>
        {isPending ? null : <ControlPill variant="pill" label="Retry" onPress={refresh} />}
      </View>
    );
  if (!model.database.live) return <Notice>{DEAD_DATABASE_MESSAGE}</Notice>;
  return (
    <ScreenViews target={target} viewIds={block.viewIds} model={model} access={props.access} />
  );
}

function ScreenViews(props: {
  target: SpacesDatabaseTarget;
  viewIds: ReadonlyArray<SpaceViewId>;
  model: DatabaseModel;
  access: SpacesReadAccess;
}) {
  const { target, model } = props;
  const views = resolveBlockViews(props.viewIds, model.views);
  const [activeId, setActiveId] = useState<SpaceViewId | undefined>(target.viewId);
  const [month, setMonth] = useState(() => monthOfNow(Date.now(), viewerZone()));
  const active = views.find((view) => view.id === activeId) ?? views[0];
  const dataSource = model.dataSources.find((entry) => entry.id === active?.dataSourceId);
  if (active === undefined) return <Notice>This database has no views.</Notice>;
  if (dataSource === undefined) return <Notice>This view is not available.</Notice>;
  return (
    <ViewList
      key={active.id}
      target={target}
      model={model}
      access={props.access}
      views={views}
      view={active}
      dataSource={dataSource}
      month={month}
      onSelect={(view) => setActiveId(view.id)}
      onMonth={setMonth}
    />
  );
}

function ViewList(props: {
  target: SpacesDatabaseTarget;
  model: DatabaseModel;
  access: SpacesReadAccess;
  views: ReturnType<typeof resolveBlockViews>;
  view: ReturnType<typeof resolveBlockViews>[number];
  dataSource: DatabaseModel["dataSources"][number];
  month: string;
  onSelect: (view: ReturnType<typeof resolveBlockViews>[number]) => void;
  onMonth: (month: string) => void;
}) {
  const { target, model, view, dataSource } = props;
  const navigation = useNavigation<NativeStackNavigationProp<ReactNavigation.RootParamList>>();
  const [adding, setAdding] = useState<{ readonly key: SpaceGroupKey } | null>(null);
  const { form, rows, items, context } = useViewContent({
    environmentId: target.environmentId,
    model,
    view,
    dataSource,
    month: props.month,
  });
  const openPage = (pageId: SpacePageId) => {
    if (!props.access.current()) return;
    navigation.push("SpacesPage", {
      environmentId: target.environmentId,
      spaceId: model.database.spaceId,
      pageId,
    });
  };
  const handlers = {
    onOpenRow: (row: SpaceDatabaseRow) => openPage(row.page.id),
    ...(model.canAddRows && form.mode === "groups"
      ? {
          onAddToGroup: (bucket: SpaceGroupKey) => setAdding({ key: bucket }),
          canAddToGroup: (bucket: SpaceGroupKey) => canAddToGroup(view, dataSource, bucket),
        }
      : {}),
    onMore: (bucket: SpaceGroupKey | null) => {
      if (!props.access.current()) return;
      if (bucket === null) rows.loadMore();
      else rows.loadBucket(bucket);
    },
  };
  const empty =
    form.message !== null
      ? form.message
      : rows.error !== null
        ? rows.error
        : rows.status === "loading"
          ? "Loading rows…"
          : "No rows.";
  return (
    <>
      <LegendList
        renderScrollComponent={NativeScrollView}
        className="flex-1"
        contentContainerStyle={{ paddingBottom: 32 }}
        data={items}
        estimatedItemSize={72}
        getItemType={(item) => item.kind}
        keyExtractor={(item) => item.key}
        recycleItems
        keyboardShouldPersistTaps="handled"
        onEndReachedThreshold={0.5}
        onEndReached={() => {
          if (form.mode === "rows" && canLoadMore(rows.rows.length, rows.hasMore)) rows.loadMore();
        }}
        ListHeaderComponent={
          <View className="gap-1 pb-2">
            <Text
              accessibilityRole="header"
              className="px-4 pt-3 text-xl font-bold text-foreground"
            >
              {model.database.icon ? `${model.database.icon} ` : ""}
              {model.database.title || "Untitled database"}
            </Text>
            <ViewSwitcher views={props.views} activeId={view.id} onSelect={props.onSelect} />
            <View className="flex-row px-4 pt-1">
              <NewRowPill
                environmentId={target.environmentId}
                model={model}
                view={view}
                dataSource={dataSource}
                {...(form.kind === "agenda" ? { month: props.month } : {})}
                onCreated={rows.retry}
                onOpenPage={openPage}
              />
            </View>
            <View className="px-4">
              <WriteNotices environmentId={target.environmentId} />
            </View>
            {rows.error !== null && items.length > 0 ? (
              <View className="items-start gap-2 px-4 py-2">
                <Text className="text-sm text-foreground-muted">{rows.error}</Text>
                <ControlPill variant="pill" label="Retry" onPress={rows.retry} />
              </View>
            ) : null}
            <Text className="px-4 py-1 text-sm text-foreground-muted">
              {viewSummary(view, dataSource)}
            </Text>
            {form.notes.map((note) => (
              <Text key={note} className="px-4 text-sm text-foreground-muted">
                {note}
              </Text>
            ))}
            {form.kind === "agenda" ? (
              <AgendaHeader
                month={props.month}
                onStep={(direction) => props.onMonth(stepMonth(props.month, direction))}
                onToday={() => props.onMonth(monthOfNow(Date.now(), viewerZone()))}
              />
            ) : null}
            {rows.loadError !== null ? (
              <View className="items-start gap-2 px-4 py-2">
                <Text className="text-sm text-foreground-muted">{rows.loadError}</Text>
                <ControlPill variant="pill" label="Retry" onPress={rows.retryLoad} />
              </View>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          <View className="items-start gap-2 px-4 py-3">
            <Text className="text-base text-foreground-muted">{empty}</Text>
            {rows.error !== null ? (
              <ControlPill variant="pill" label="Retry" onPress={rows.retry} />
            ) : null}
          </View>
        }
        ListFooterComponent={
          rows.loadingMore ? (
            <Text className="px-4 py-3 text-sm text-foreground-muted">Loading more rows…</Text>
          ) : null
        }
        renderItem={({ item }) => (
          <DatabaseListItem item={item} form={form} context={context} handlers={handlers} />
        )}
      />
      {adding === null ? null : (
        <NewRowSheet
          environmentId={target.environmentId}
          view={view}
          dataSource={dataSource}
          groupKey={adding.key}
          onCreated={rows.retry}
          onClose={() => setAdding(null)}
        />
      )}
    </>
  );
}
