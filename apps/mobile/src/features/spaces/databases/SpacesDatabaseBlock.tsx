import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useNavigation } from "@react-navigation/native";
import { resolveBlockViews } from "@t2code/client-runtime/spaces";
import type { EnvironmentId } from "@t2code/contracts";
import type {
  SpaceDatabaseBlock,
  SpaceDatabaseRow,
  SpaceDatabaseView,
  SpaceId,
  SpacePageId,
  SpaceViewId,
} from "@t2code/contracts/spaces";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { ControlPill } from "../../../components/ui/ControlPill";
import { monthOfNow, stepMonth } from "./agenda";
import { AgendaHeader } from "./AgendaHeader";
import { DATABASES_NEED_NEWER_SERVER, databaseLimitsOf } from "./capability";
import { DatabaseViewList } from "./DatabaseViewList";
import { NewRowPill } from "./NewRowPill";
import { WriteNotices } from "./WriteNotices";
import { useDatabaseModel, type DatabaseModel } from "./useDatabaseModel";
import { useViewContent } from "./useViewContent";
import { ViewSwitcher } from "./ViewSwitcher";
import { BLOCK_PREVIEW_ROWS, FULL_PAGE_PREVIEW_ROWS, previewItems, viewSummary } from "./viewForms";
import { viewerZone } from "../../../state/spacesDatabases";
import { useSpacesReadAccess } from "../../../state/spaces";

export const DEAD_DATABASE_MESSAGE =
  "The original database was deleted. Restore its page on desktop to use this view.";

/** The database block inside a page: its views, a bounded preview of the first window, and a way in. */
export function SpacesDatabaseBlock(props: {
  readonly block: SpaceDatabaseBlock;
  readonly environmentId: EnvironmentId;
  readonly spaceId: SpaceId;
  readonly pageId: SpacePageId;
  /** The page is only this database: no title, a longer preview. */
  readonly fullPage: boolean;
}) {
  const access = useSpacesReadAccess(props.environmentId);
  if (databaseLimitsOf(access.capability) === null)
    return (
      <Text className="px-4 py-3 text-base text-foreground-muted">
        {DATABASES_NEED_NEWER_SERVER}
      </Text>
    );
  return <LoadedBlock {...props} />;
}

function LoadedBlock(props: Parameters<typeof SpacesDatabaseBlock>[0]) {
  const { block, environmentId } = props;
  const { model, isPending, error, refresh } = useDatabaseModel(
    environmentId,
    block.content.databaseId,
  );
  if (model === null)
    return (
      <View className="gap-2 px-4 py-3">
        <Text className="text-base text-foreground-muted">
          {isPending ? "Loading database…" : (error ?? "This database could not be loaded.")}
        </Text>
        {isPending ? null : <ControlPill variant="pill" label="Retry" onPress={refresh} />}
      </View>
    );
  if (!model.database.live)
    return (
      <Text className="px-4 py-3 text-base text-foreground-muted">{DEAD_DATABASE_MESSAGE}</Text>
    );
  return <BlockViews {...props} model={model} />;
}

function BlockViews(props: Parameters<typeof SpacesDatabaseBlock>[0] & { model: DatabaseModel }) {
  const { block, model } = props;
  const navigation = useNavigation<NativeStackNavigationProp<ReactNavigation.RootParamList>>();
  const views = resolveBlockViews(block.content.viewIds, model.views);
  const [activeId, setActiveId] = useState<SpaceViewId | undefined>(undefined);
  const active = views.find((view) => view.id === activeId) ?? views[0];
  const open = (viewId: SpaceViewId | undefined) =>
    navigation.push("SpacesDatabase", {
      environmentId: props.environmentId,
      spaceId: props.spaceId,
      pageId: props.pageId,
      blockId: block.id,
      databaseId: block.content.databaseId,
      viewIds: [...block.content.viewIds],
      ...(viewId === undefined ? {} : { viewId }),
    });
  return (
    <View className="gap-1 py-2">
      {props.fullPage || block.content.hideTitle === true ? null : (
        <Text accessibilityRole="header" className="px-4 text-lg font-bold text-foreground">
          {model.database.icon ? `${model.database.icon} ` : ""}
          {model.database.title || "Untitled database"}
        </Text>
      )}
      <View className="px-4">
        <WriteNotices environmentId={props.environmentId} />
      </View>
      <ViewSwitcher views={views} activeId={active?.id} onSelect={(view) => setActiveId(view.id)} />
      {active === undefined ? (
        <Text className="px-4 py-2 text-base text-foreground-muted">
          This database has no views.
        </Text>
      ) : (
        <BlockPreview
          key={active.id}
          {...props}
          view={active}
          onOpenDatabase={() => open(active.id)}
        />
      )}
    </View>
  );
}

function BlockPreview(
  props: Parameters<typeof SpacesDatabaseBlock>[0] & {
    model: DatabaseModel;
    view: SpaceDatabaseView;
    onOpenDatabase: () => void;
  },
) {
  const { model, view } = props;
  const navigation = useNavigation<NativeStackNavigationProp<ReactNavigation.RootParamList>>();
  const openPage = (pageId: SpacePageId) =>
    navigation.push("SpacesPage", {
      environmentId: props.environmentId,
      spaceId: model.database.spaceId,
      pageId,
    });
  const dataSource = model.dataSources.find((entry) => entry.id === view.dataSourceId);
  const [month, setMonth] = useState(() => monthOfNow(Date.now(), viewerZone()));
  if (dataSource === undefined)
    return (
      <Text className="px-4 py-2 text-base text-foreground-muted">This view is not available.</Text>
    );
  return (
    <PreviewBody
      {...props}
      dataSource={dataSource}
      month={month}
      setMonth={setMonth}
      onOpenRow={(row) => openPage(row.page.id)}
      onOpenPage={openPage}
    />
  );
}

function PreviewBody(
  props: Parameters<typeof BlockPreview>[0] & {
    dataSource: DatabaseModel["dataSources"][number];
    month: string;
    setMonth: (month: string) => void;
    onOpenRow: (row: SpaceDatabaseRow) => void;
    onOpenPage: (pageId: SpacePageId) => void;
  },
) {
  const { form, rows, items, context } = useViewContent({
    environmentId: props.environmentId,
    model: props.model,
    view: props.view,
    dataSource: props.dataSource,
    month: props.month,
  });
  const preview = previewItems(items, props.fullPage ? FULL_PAGE_PREVIEW_ROWS : BLOCK_PREVIEW_ROWS);
  const agenda = form.kind === "agenda";
  return (
    <View>
      <Text className="px-4 py-1 text-sm text-foreground-muted">
        {viewSummary(props.view, props.dataSource)}
      </Text>
      {form.notes.map((note) => (
        <Text key={note} className="px-4 pb-1 text-sm text-foreground-muted">
          {note}
        </Text>
      ))}
      {agenda ? (
        <AgendaHeader
          month={props.month}
          onStep={(direction) => props.setMonth(stepMonth(props.month, direction))}
          onToday={() => props.setMonth(monthOfNow(Date.now(), viewerZone()))}
        />
      ) : null}
      {form.message !== null ? (
        <Text className="px-4 py-2 text-base text-foreground-muted">{form.message}</Text>
      ) : rows.error !== null ? (
        <View className="items-start gap-2 px-4 py-2">
          <Text className="text-base text-foreground-muted">{rows.error}</Text>
          <ControlPill variant="pill" label="Retry" onPress={rows.retry} />
        </View>
      ) : rows.status === "loading" && rows.rows.length === 0 && rows.groups === null ? (
        <Text className="px-4 py-2 text-base text-foreground-muted">Loading rows…</Text>
      ) : preview.length === 0 ? (
        <Text className="px-4 py-2 text-base text-foreground-muted">No rows.</Text>
      ) : (
        <DatabaseViewList
          items={preview}
          form={form}
          context={context}
          handlers={{ onOpenRow: props.onOpenRow, onMore: props.onOpenDatabase }}
        />
      )}
      <View className="flex-row gap-2 px-4 pt-2">
        <ControlPill variant="pill" label="Open database" onPress={props.onOpenDatabase} />
        <NewRowPill
          environmentId={props.environmentId}
          model={props.model}
          view={props.view}
          dataSource={props.dataSource}
          {...(agenda ? { month: props.month } : {})}
          onCreated={rows.retry}
          onOpenPage={props.onOpenPage}
        />
      </View>
    </View>
  );
}
