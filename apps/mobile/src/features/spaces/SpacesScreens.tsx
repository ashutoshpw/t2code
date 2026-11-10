import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { canBrowseSpaces } from "@t2code/client-runtime/state/spaces";
import { SpacePageNavigation } from "@t2code/client-runtime/spaces";
import { EnvironmentId } from "@t2code/contracts";
import type { SpaceCursor, SpaceId, SpacePageId } from "@t2code/contracts/spaces";
import { useMemo, useState, useSyncExternalStore } from "react";
import { LegendList } from "@legendapp/list/react-native";
import { View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { ListRow } from "../../components/ui/ListRow";
import { ControlPill } from "../../components/ui/ControlPill";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { appAtomRegistry } from "../../state/atom-registry";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { spacesEnvironment, useSpacesReadAccess } from "../../state/spaces";
import { type SpacesReadAccess, spacesAvailabilityMessage } from "./reader";
import { readSpacesPageTarget, readSpacesLibraryTarget } from "./navigation";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { SpacesLibraryActions } from "./SpacesLibraryActions";
import { SpacesSearch } from "./SpacesReferences";
import { Notice, AccessNotice } from "./spacesScreenSupport";
import { PageReader } from "./SpacesPageReader";

type LibraryParams =
  | { readonly environmentId?: EnvironmentId; readonly spaceId?: SpaceId }
  | undefined;

export function SpacesLibraryRouteScreen({ route }: StaticScreenProps<LibraryParams>) {
  const navigation = useNavigation<NativeStackNavigationProp<ReactNavigation.RootParamList>>();
  const { environments, isReady } = useEnvironments();
  const params = readSpacesLibraryTarget(route.params);
  const environmentId = params?.environmentId;
  return (
    <SettingsScreen title="Spaces">
      {params === null ? (
        <Notice>This Spaces link is invalid.</Notice>
      ) : environmentId ? (
        <SpacesLibrary
          key={JSON.stringify(route.params)}
          environmentId={environmentId}
          spaceId={params.spaceId}
        />
      ) : (
        <LegendList
          renderScrollComponent={NativeScrollView}
          data={environments}
          keyExtractor={(item) => item.environmentId}
          ListHeaderComponent={<Notice>Choose an environment to browse its Spaces.</Notice>}
          ListEmptyComponent={
            <Notice>
              {isReady ? "Add an environment in Settings to use Spaces." : "Loading environments…"}
            </Notice>
          }
          renderItem={({ item }) => (
            <ListRow
              icon="server.rack"
              label={item.label}
              description={item.connection.phase === "connected" ? "Browse Spaces" : "Disconnected"}
              onPress={() =>
                navigation.push("SpacesLibrary", { environmentId: item.environmentId })
              }
            />
          )}
        />
      )}
    </SettingsScreen>
  );
}

function SpacesLibrary({
  environmentId,
  spaceId,
}: {
  environmentId: EnvironmentId;
  spaceId?: SpaceId;
}) {
  const navigation = useNavigation<NativeStackNavigationProp<ReactNavigation.RootParamList>>();
  const access = useSpacesReadAccess(environmentId);
  const [cursor, setCursor] = useState<SpaceCursor>();
  const query = useEnvironmentQuery(
    canBrowseSpaces(access.availability)
      ? spacesEnvironment.list({
          environmentId,
          input: {
            environmentId,
            limit: Math.min(20, access.capability?.limits.maxListRows ?? 20),
            ...(cursor ? { cursor } : {}),
          },
        })
      : null,
  );
  if (!canBrowseSpaces(access.availability))
    return <AccessNotice access={access} environmentId={environmentId} />;
  const data = !query.isPending && access.current() ? query.data : null;
  const bounded =
    data &&
    data.items.length <= Math.min(20, access.capability?.limits.maxListRows ?? 20) &&
    new TextEncoder().encode(JSON.stringify(data)).byteLength <=
      Math.min(2 * 1024 * 1024, access.capability?.limits.maxListResponseBytes ?? 0);
  const selected = spaceId ?? (bounded ? data.defaultSpaceId : undefined);
  return (
    <View className="flex-1">
      <SpacesSearch environmentId={environmentId} />
      <SpacesLibraryActions key={environmentId} environmentId={environmentId} spaceId={selected} />
      <View className="flex-row gap-2 px-4 py-2">
        <ControlPill
          variant="pill"
          label="Environments"
          onPress={() => navigation.push("SpacesLibrary")}
        />
        <ControlPill
          variant="pill"
          label="First spaces"
          onPress={() => {
            if (cursor) setCursor(undefined);
            else query.refresh();
          }}
        />
        <ControlPill
          variant="pill"
          label="Next spaces"
          disabled={!bounded || data.nextCursor === null}
          onPress={() => {
            if (bounded && data.nextCursor) setCursor(data.nextCursor);
          }}
        />
      </View>
      {query.error ? (
        <Notice>{query.error}</Notice>
      ) : !data ? (
        <Notice>Loading spaces…</Notice>
      ) : !bounded ? (
        <Notice>This spaces window exceeds the read limit.</Notice>
      ) : (
        <LegendList
          renderScrollComponent={NativeScrollView}
          style={{ maxHeight: 180 }}
          data={data.items}
          keyExtractor={(item) => item.id}
          ListEmptyComponent={
            <Notice>
              {data.nextCursor
                ? "No spaces in this window. Continue to the next window."
                : "No spaces in this environment."}
            </Notice>
          }
          renderItem={({ item }) => (
            <ListRow
              icon="folder"
              label={item.title || "Untitled space"}
              description={item.isDefault ? "Default space" : undefined}
              onPress={() => navigation.push("SpacesLibrary", { environmentId, spaceId: item.id })}
            />
          )}
        />
      )}
      {selected && bounded ? (
        <PageLibrary
          key={selected}
          environmentId={environmentId}
          spaceId={selected}
          access={access}
        />
      ) : null}
    </View>
  );
}

function PageLibrary({
  environmentId,
  spaceId,
  access,
}: {
  environmentId: EnvironmentId;
  spaceId: SpaceId;
  access: SpacesReadAccess;
}) {
  const navigation = useNavigation<NativeStackNavigationProp<ReactNavigation.RootParamList>>();
  const pages = useMemo(
    () =>
      new SpacePageNavigation({
        registry: appAtomRegistry,
        pages: spacesEnvironment.pages,
        environmentId,
        spaceId,
        version: access.capability?.version === 1 ? 1 : 2,
        maxRows: access.capability?.limits.maxListRows ?? 20,
      }),
    [environmentId, spaceId, access],
  );
  const snapshot = useSyncExternalStore(pages.subscribe, pages.getSnapshot);
  const rows = snapshot.windows.flatMap((window) => [
    { key: `window:${window.parentPageId}`, window, page: null },
    ...(window.data?.items ?? []).map((page) => ({ key: `page:${page.id}`, window, page })),
  ]);
  return (
    <LegendList
      renderScrollComponent={NativeScrollView}
      data={access.current() ? rows : []}
      keyExtractor={(item) => item.key}
      extraData={access}
      ListHeaderComponent={
        <>
          <Notice>{spacesAvailabilityMessage[access.availability]}</Notice>
          {snapshot.error ? <Notice>{snapshot.error}</Notice> : null}
        </>
      }
      renderItem={({ item }) => {
        const page = item.page;
        return page ? (
          <View style={{ marginLeft: item.window.path.length * 12 }}>
            <ListRow
              icon="doc.text"
              label={`${page.icon ? `${page.icon} ` : ""}${page.title || "Untitled page"}`}
              onPress={() =>
                navigation.push("SpacesPage", { environmentId, spaceId, pageId: page.id })
              }
            />
            {access.capability?.version === 2 ? (
              <View className="items-start px-4">
                <ControlPill
                  variant="pill"
                  label="Child pages"
                  onPress={() => pages.expand(item.window.parentPageId, page.id)}
                />
              </View>
            ) : null}
          </View>
        ) : (
          <View className="gap-2 p-4">
            <Text className="text-base font-bold text-foreground">
              {item.window.data?.space.title ?? "Pages"}
              {item.window.parentPageId ? " · child pages" : ""}
            </Text>
            {item.window.pending ? (
              <Notice>Loading pages…</Notice>
            ) : item.window.error ? (
              <Notice>{item.window.error}</Notice>
            ) : item.window.data?.items.length === 0 ? (
              <Notice>
                {item.window.data.nextCursor
                  ? "No pages in this window. Continue to the next window."
                  : "No pages here yet. Create pages on desktop."}
              </Notice>
            ) : null}
            <View className="flex-row gap-2">
              <ControlPill
                variant="pill"
                label="First pages"
                disabled={item.window.pending}
                onPress={() => pages.first(item.window.parentPageId)}
              />
              <ControlPill
                variant="pill"
                label="Next pages"
                disabled={item.window.pending || !item.window.data?.nextCursor}
                onPress={() => pages.next(item.window.parentPageId)}
              />
            </View>
          </View>
        );
      }}
    />
  );
}

export function SpacesPageRouteScreen({
  route,
}: StaticScreenProps<{
  readonly environmentId: EnvironmentId;
  readonly spaceId: SpaceId;
  readonly pageId: SpacePageId;
  readonly block?: string;
}>) {
  const target = readSpacesPageTarget(route.params);
  return (
    <SettingsScreen title="Space page">
      {target ? (
        <SpacesLibraryActions
          key={target.environmentId}
          environmentId={target.environmentId}
          statusOnly
        />
      ) : null}
      {target ? (
        <PageReader
          key={JSON.stringify([target.environmentId, target.pageId, target.blockId])}
          target={target}
        />
      ) : (
        <Notice>This Spaces link is invalid.</Notice>
      )}
    </SettingsScreen>
  );
}
