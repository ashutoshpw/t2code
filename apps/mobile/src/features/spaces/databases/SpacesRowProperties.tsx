import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useNavigation } from "@react-navigation/native";
import {
  findDataSourceHomes,
  knownProperty,
  type CellTextContext,
} from "@t2code/client-runtime/spaces";
import type { EnvironmentId } from "@t2code/contracts";
import {
  SPACE_TITLE_PROPERTY_ID,
  type SpaceCellValue,
  type SpaceDatabaseProperty,
  type SpaceDatabaseRow,
  type SpaceId,
  type SpaceDataSource,
  type SpacePageId,
  type SpaceRelatedPage,
} from "@t2code/contracts/spaces";
import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { ControlPill } from "../../../components/ui/ControlPill";
import { ListToggleRow } from "../../../components/ui/ListToggleRow";
import { useEnvironmentQuery } from "../../../state/query";
import { useSpacesReadAccess } from "../../../state/spaces";
import {
  databaseAtoms,
  databaseWriter,
  listDatabasePage,
  viewerZone,
} from "../../../state/spacesDatabases";
import { CellEditSheet, type SheetEditor } from "./CellEditSheet";
import { CellValueView } from "./CellValueView";
import { commitCheckbox, editorFor, UNSUPPORTED_NOTE, type CellEditor } from "./cellEdit";
import { cardLine, type CardLine, type LineRelation } from "./cellText";
import { useDatabaseModel } from "./useDatabaseModel";
import { useRowCells } from "./useRowCells";
import { WriteNotices } from "./WriteNotices";

const noHint: CellTextContext["optionHint"] = () => undefined;

export const TEMPLATE_NOTE = "Template · edit on desktop";
const NO_TARGETS: ReadonlySet<string> = new Set();

/** The properties of a row page, above its body. Simple cells edit in place; the rest stay read-only with a note. */
export function SpacesRowProperties(props: {
  readonly environmentId: EnvironmentId;
  readonly pageId: SpacePageId;
}) {
  const { environmentId, pageId } = props;
  const query = useEnvironmentQuery(
    databaseAtoms.row({
      environmentId,
      input: { environmentId, pageId, timeZone: viewerZone() },
    }),
  );
  const data = query.data;
  if (data === null)
    return query.isPending ? (
      <Text className="py-2 text-sm text-foreground-muted">Loading properties…</Text>
    ) : (
      <View className="items-start gap-2 py-2">
        <Text className="text-sm text-foreground-muted">
          This row's properties could not be loaded.
        </Text>
        <ControlPill variant="pill" label="Retry" onPress={query.refresh} />
      </View>
    );
  return (
    <RowPropertyList
      environmentId={environmentId}
      row={data.row}
      template={data.template}
      databaseId={data.dataSource.databaseId}
      dataSourceId={data.dataSource.id}
      relatedPages={data.relatedPages}
      dataRevision={data.dataSource.dataRevision}
    />
  );
}

function RowPropertyList(props: {
  environmentId: EnvironmentId;
  row: SpaceDatabaseRow;
  template: boolean;
  databaseId: SpaceDataSource["databaseId"];
  dataSourceId: SpaceDataSource["id"];
  relatedPages: Readonly<Record<string, SpaceRelatedPage>>;
  dataRevision: number;
}) {
  const { environmentId, relatedPages } = props;
  const cells = useRowCells(environmentId, props.row, props.dataRevision);
  const row = { ...props.row, cells };
  const { model, isPending, refresh } = useDatabaseModel(environmentId, props.databaseId);
  const access = useSpacesReadAccess(environmentId);
  const [editing, setEditing] = useState<{
    readonly property: SpaceDatabaseProperty;
    readonly editor: SheetEditor;
  } | null>(null);
  useFlushOnLeave(environmentId);
  const navigation = useNavigation<NativeStackNavigationProp<ReactNavigation.RootParamList>>();
  const dataSource = model?.dataSources.find((entry) => entry.id === props.dataSourceId);
  const spaceId = model?.database.spaceId;
  const targets = useRelatedTargets(
    environmentId,
    spaceId,
    Object.values(relatedPages).map((page) => page.dataSourceId),
  );
  if (dataSource === undefined)
    return isPending ? (
      <Text className="py-2 text-sm text-foreground-muted">Loading properties…</Text>
    ) : (
      <View className="items-start gap-2 py-2">
        <Text className="text-sm text-foreground-muted">
          This row's properties could not be loaded.
        </Text>
        <ControlPill variant="pill" label="Retry" onPress={refresh} />
      </View>
    );
  const context: CellTextContext = { relatedPages, optionHint: noHint, timeZone: viewerZone() };
  const canEdit = model !== null && model.canEditCells && !props.template;
  const entries = Object.values(dataSource.properties)
    .sort(
      (a, b) =>
        Number(b.id === SPACE_TITLE_PROPERTY_ID) - Number(a.id === SPACE_TITLE_PROPERTY_ID) ||
        a.position - b.position,
    )
    .map((property) => {
      const line: CardLine = cardLine(
        row,
        { property, known: knownProperty(property) },
        context,
      ) ?? { propertyId: property.id, name: property.name, text: "" };
      return { property, line, editor: editorFor(property, cells[property.id]) };
    });
  const open = (related: LineRelation) => {
    if (spaceId === undefined) return;
    navigation.push("SpacesPage", { environmentId, spaceId, pageId: related.pageId });
  };
  // Every handler checks the grant again: it may have changed since the list was drawn.
  const write = (property: SpaceDatabaseProperty, value: SpaceCellValue | null) => {
    if (!canEdit || !access.current()) return;
    databaseWriter(environmentId).editCell({
      dataSourceId: props.dataSourceId,
      pageId: row.page.id,
      propertyId: property.id,
      value,
    });
  };
  // A related row opens only when its database is one this space lists; otherwise its title is plain text.
  const shown = entries.map((entry) =>
    entry.line.related === undefined
      ? entry
      : {
          ...entry,
          line: {
            ...entry.line,
            related: entry.line.related.map((related) =>
              related.dataSourceId !== undefined && targets.has(related.dataSourceId)
                ? related
                : { ...related, dataSourceId: undefined },
            ),
          },
        },
  );
  return (
    <View className="gap-2 py-2">
      <WriteNotices environmentId={environmentId} />
      {props.template ? (
        <Text className="text-sm text-foreground-muted">{TEMPLATE_NOTE}</Text>
      ) : null}
      {shown.map(({ property, line, editor }) =>
        canEdit && editor.kind === "checkbox" ? (
          <ListToggleRow
            key={line.propertyId}
            label={line.name}
            value={editor.checked}
            onValueChange={(checked) => write(property, commitCheckbox(checked))}
          />
        ) : (
          <PropertyRow
            key={line.propertyId}
            line={line}
            note={canEdit ? noteOf(editor) : null}
            onEdit={
              canEdit && editor.kind !== "readonly" && editor.kind !== "checkbox"
                ? () => setEditing({ property, editor })
                : undefined
            }
            onOpenRelated={open}
          />
        ),
      )}
      {editing === null ? null : (
        <CellEditSheet
          title={editing.property.name}
          editor={editing.editor}
          onCommit={(value) => write(editing.property, value)}
          onClose={() => setEditing(null)}
        />
      )}
    </View>
  );
}

const noteOf = (editor: CellEditor): string | null =>
  editor.kind === "readonly" && editor.note !== UNSUPPORTED_NOTE ? editor.note : null;

function PropertyRow(props: {
  readonly line: CardLine;
  readonly note: string | null;
  readonly onEdit: (() => void) | undefined;
  readonly onOpenRelated: (related: LineRelation) => void;
}) {
  const { line } = props;
  const value =
    line.text === "" && line.checked === undefined ? (
      <Text className="text-sm text-foreground-muted">Empty</Text>
    ) : (
      <CellValueView line={line} onOpenRelated={props.onOpenRelated} />
    );
  const body = (
    <>
      <Text className="text-sm text-foreground-muted">{line.name}</Text>
      {value}
      {props.note === null ? null : (
        <Text className="text-xs text-foreground-muted">{props.note}</Text>
      )}
    </>
  );
  return props.onEdit === undefined ? (
    <View className="gap-0.5">{body}</View>
  ) : (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Edit ${line.name}`}
      className="gap-0.5 active:opacity-70"
      onPress={props.onEdit}
    >
      {body}
    </Pressable>
  );
}

/** Sends the queued edits when the row page loses focus or unmounts. */
function useFlushOnLeave(environmentId: EnvironmentId) {
  const navigation = useNavigation();
  // oxlint-disable-next-line t2code/no-unreasoned-state-sync -- Flush the external writer queue when this screen is left.
  useEffect(() => {
    const writer = databaseWriter(environmentId);
    const stop = navigation.addListener("blur", () => void writer.flush());
    return () => {
      stop();
      void writer.flush();
    };
  }, [navigation, environmentId]);
}

function useRelatedTargets(
  environmentId: EnvironmentId,
  spaceId: SpaceId | undefined,
  dataSourceIds: ReadonlyArray<string>,
): ReadonlySet<string> {
  const key = [...new Set(dataSourceIds)].sort().join(",");
  const [found, setFound] = useState<{ key: string; ids: ReadonlySet<string> } | null>(null);
  // oxlint-disable-next-line t2code/no-unreasoned-state-sync -- Reads the databases of the row's space from the server to learn which related rows can be opened; asked again only when the wanted data sources change.
  useEffect(() => {
    if (spaceId === undefined || key === "") return;
    let live = true;
    void findDataSourceHomes({
      ids: key.split(","),
      first: null,
      listPage: (cursor, anySpace) =>
        anySpace
          ? Promise.resolve({ items: [], nextCursor: null })
          : listDatabasePage(environmentId, spaceId, cursor),
    }).then(
      (homes) => {
        if (live) setFound({ key, ids: new Set(homes.homes.keys()) });
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [environmentId, spaceId, key]);
  return found?.key === key ? found.ids : NO_TARGETS;
}
