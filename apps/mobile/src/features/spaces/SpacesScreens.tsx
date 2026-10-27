import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useNavigation, usePreventRemove, type StaticScreenProps } from "@react-navigation/native";
import { canBrowseSpaces } from "@t2code/client-runtime/state/spaces";
import { SpacePageNavigation, type SpacePageNavigationTarget } from "@t2code/client-runtime/spaces";
import { EnvironmentId } from "@t2code/contracts";
import type { SpaceCursor, SpaceId, SpacePageId, SpaceBlock } from "@t2code/contracts/spaces";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { FlatList, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ListRow } from "../../components/ui/ListRow";
import { ControlPill } from "../../components/ui/ControlPill";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { appAtomRegistry } from "../../state/atom-registry";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import {
  acquireSpacesPageReader,
  spacesEnvironment,
  useSpacesReadAccess,
} from "../../state/spaces";
import { type SpacesReadAccess, spacesAvailabilityMessage } from "./reader";
import { readSpacesPageTarget, readSpacesLibraryTarget } from "./navigation";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { SpaceBlockReader } from "./SpaceBlockReader";
import { SpacesLibraryActions } from "./SpacesLibraryActions";
import { nativeDocumentForSpaceBlock } from "./nativeSpacesAdapter";
import { SpacesNativeBlockEditor, spacesNativeEditorAvailable } from "./SpacesNativeBlockEditor";
import * as Dialog from "../../components/ui/Dialog";

type LibraryParams =
  | { readonly environmentId?: EnvironmentId; readonly spaceId?: SpaceId }
  | undefined;

function Notice({ children }: { children: string }) {
  return (
    <Text accessibilityLiveRegion="polite" className="px-4 py-3 text-base text-foreground-muted">
      {children}
    </Text>
  );
}

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
        <FlatList
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

function AccessNotice({
  access,
  environmentId,
}: {
  access: SpacesReadAccess;
  environmentId: EnvironmentId;
}) {
  const navigation = useNavigation<NativeStackNavigationProp<ReactNavigation.RootParamList>>();
  return (
    <View className="gap-3 p-4">
      <Notice>{spacesAvailabilityMessage[access.availability]}</Notice>
      <ControlPill
        variant="pill"
        label="Environment settings"
        onPress={() => navigation.navigate("SettingsEnvironmentDetail", { environmentId })}
      />
    </View>
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
        <FlatList
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
    <FlatList
      renderScrollComponent={NativeScrollView}
      data={access.current() ? rows : []}
      keyExtractor={(item) => item.key}
      ListHeaderComponent={
        <>
          <Notice>{spacesAvailabilityMessage[access.availability]}</Notice>
          {snapshot.error ? <Notice>{snapshot.error}</Notice> : null}
        </>
      }
      renderItem={({ item }) =>
        item.page ? (
          <View style={{ marginLeft: item.window.path.length * 12 }}>
            <ListRow
              icon="doc.text"
              label={item.page.title || "Untitled page"}
              onPress={() =>
                navigation.push("SpacesPage", { environmentId, spaceId, pageId: item.page!.id })
              }
            />
            {access.capability?.version === 2 ? (
              <View className="items-start px-4">
                <ControlPill
                  variant="pill"
                  label="Child pages"
                  onPress={() => pages.expand(item.window.parentPageId, item.page!.id)}
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
        )
      }
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

function blockDepth(block: SpaceBlock, blocks: readonly SpaceBlock[]) {
  const seen = new Set([block.id]);
  let parentId = block.parentId;
  let depth = 0;
  while (parentId !== null && depth < 16 && !seen.has(parentId)) {
    seen.add(parentId);
    depth++;
    parentId = blocks.find((parent) => parent.id === parentId)?.parentId ?? null;
  }
  return depth;
}

type PageLease = Awaited<ReturnType<typeof acquireSpacesPageReader>>;

function PageReader({ target }: { target: SpacePageNavigationTarget }) {
  const access = useSpacesReadAccess(target.environmentId);
  const ownedLease = useRef<PageLease | null>(null);
  const [attempt, setAttempt] = useState(0);
  const stamp = useMemo(() => ({ target, access, attempt }), [target, access, attempt]);
  const [view, setView] = useState<{
    stamp: typeof stamp;
    lease: PageLease | null;
    error: string | null;
  } | null>(null);
  // oxlint-disable-next-line t2code/react-effect-budget -- Acquire the shared remote document owner and release only this view's lease on navigation or connection changes.
  useEffect(() => {
    if (ownedLease.current) return;
    const abort = new AbortController();
    if (canBrowseSpaces(access.availability)) {
      void acquireSpacesPageReader(target, access, abort.signal).then(
        (lease) => {
          if (abort.signal.aborted) {
            lease.release();
            return;
          }
          ownedLease.current = lease;
          setView({ stamp, lease, error: null });
        },
        (cause: unknown) => {
          if (!abort.signal.aborted)
            setView({
              stamp,
              lease: null,
              error: cause instanceof Error ? cause.message : "Could not open this page.",
            });
        },
      );
    }
    return () => {
      abort.abort();
    };
  }, [target, access, stamp]);
  const lease = view?.lease;
  // oxlint-disable-next-line t2code/react-effect-budget -- Retain a mounted document through access changes; only route removal releases its lease.
  useEffect(
    () => () => {
      ownedLease.current?.release();
      ownedLease.current = null;
    },
    [],
  );
  if (lease) return <DocumentReader lease={lease} access={access} />;
  if (!canBrowseSpaces(access.availability))
    return <AccessNotice access={access} environmentId={target.environmentId} />;
  if (view?.stamp !== stamp) return <Notice>Opening page and local draft…</Notice>;
  return (
    <View className="gap-2">
      <Notice>{view.error ?? "Could not open this page."}</Notice>
      <ControlPill
        variant="pill"
        label="Retry opening page"
        disabled={!access.current()}
        onPress={() => {
          if (!ownedLease.current && access.current()) setAttempt((value) => value + 1);
        }}
      />
    </View>
  );
}

function DocumentReader({ lease, access }: { lease: PageLease; access: SpacesReadAccess }) {
  const navigation = useNavigation<NativeStackNavigationProp<ReactNavigation.RootParamList>>();
  const { reader, target } = lease;
  const snapshot = useSyncExternalStore(reader.subscribe, reader.getSnapshot);
  const editing = reader.editing;
  const editorState = useSyncExternalStore(editing.subscribe, editing.getSnapshot);
  const [owner] = useState(() => Symbol("Spaces page editor"));
  const [actionError, setActionError] = useState<string | null>(null);
  const list = useRef<FlatList<SpaceBlock>>(null);
  const focus = editorState.focus?.owner === owner ? editorState.focus : null;
  const readable = canBrowseSpaces(access.availability) && access.current();
  const writable =
    readable && access.availability === "writable" && access.capability?.version === 2;
  const editable =
    writable &&
    snapshot.session.hydrated &&
    !snapshot.structureBlocked &&
    !snapshot.loading &&
    snapshot.error === null &&
    editorState.busy !== "persist" &&
    snapshot.session.status !== "conflict" &&
    snapshot.session.persistenceError === null;
  const nativeState = editorState.focus?.publication.getSnapshot();
  usePreventRemove(focus !== null, () => {
    Dialog.alert(
      "Finish this block first",
      "Use Done editing to retain the complete native input before leaving. If a change was rejected, recover it or restore access first.",
    );
  });
  // oxlint-disable-next-line t2code/react-effect-budget -- Refresh remote metadata on a connection change without replacing the mounted native input or its retained session.
  useEffect(() => {
    if (canBrowseSpaces(access.availability) && access.current()) void reader.first();
    else reader.invalidate();
  }, [reader, access]);
  const location = access.current() ? snapshot.location : null;
  const blocks = snapshot.session.hydrated ? snapshot.session.blocks : [];
  const currentTarget = location
    ? {
        ...target,
        spaceId: location.page.spaceId,
        pageId: location.page.id,
        blockId: location.resolvedBlockId ?? target.blockId,
      }
    : target;
  return (
    <View className="flex-1">
      {!readable ? <AccessNotice access={access} environmentId={target.environmentId} /> : null}
      {!readable && (snapshot.session.dirty || focus) ? (
        <Notice>
          Your local draft and active input are retained. Restore read access to continue.
        </Notice>
      ) : null}
      <FlatList
        ref={list}
        style={!readable ? { opacity: 0, height: 0 } : undefined}
        pointerEvents={readable ? "auto" : "none"}
        accessibilityElementsHidden={!readable}
        importantForAccessibility={readable ? "auto" : "no-hide-descendants"}
        renderScrollComponent={NativeScrollView}
        data={blocks}
        keyExtractor={(block) => block.id}
        initialNumToRender={12}
        windowSize={5}
        scrollEnabled={editorState.focus === null}
        removeClippedSubviews={false}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <View className="gap-2 p-4">
            <Text accessibilityRole="header" className="text-xl font-bold text-foreground">
              {location?.page.title || "Space page"}
            </Text>
            {location ? (
              <Text className="text-sm text-foreground-muted">
                {[location.space.title, ...location.ancestors.map((page) => page.title)].join(
                  " / ",
                )}{" "}
                · Revision {location.page.revision}
              </Text>
            ) : null}
            <Notice>{spacesAvailabilityMessage[access.availability]}</Notice>
            {snapshot.structureBlocked ? (
              <Notice>
                This page is reserved by a structural operation. Recover its exact receipt before
                editing.
              </Notice>
            ) : null}
            {location ? (
              <SpacesLibraryActions
                environmentId={target.environmentId}
                page={location.page}
                current={() => !!location.current()}
                blocked={
                  snapshot.loading ||
                  snapshot.error !== null ||
                  snapshot.structureBlocked ||
                  editorState.focus !== null ||
                  editorState.busy !== null ||
                  snapshot.session.dirty ||
                  snapshot.session.pending !== null
                }
              />
            ) : null}
            <Notice>
              {snapshot.session.persistenceError !== null
                ? "The local draft could not be loaded or stored. Existing data is retained; try refreshing."
                : !snapshot.session.hydrated
                  ? "Loading the local draft before showing page content…"
                  : snapshot.session.status === "uncertain"
                    ? "The previous save outcome is uncertain. Its exact request and your local draft are retained."
                    : snapshot.session.status === "conflict"
                      ? "This page changed elsewhere. Your local draft is retained read-only."
                      : snapshot.session.status === "draft"
                        ? "Local draft retained on this device. Use Save when ready."
                        : snapshot.session.status === "saving"
                          ? "A save is pending; newer local content remains retained."
                          : "Saved page."}
            </Notice>
            {access.capability?.version === 1 ? (
              <Notice>This environment’s older Spaces version is read-only on mobile.</Notice>
            ) : null}
            {!spacesNativeEditorAvailable ? (
              <Notice>
                Update this device’s app to edit Spaces text. Existing blocks remain readable.
              </Notice>
            ) : null}
            {editorState.error || actionError ? (
              <Notice>{editorState.error ?? actionError!}</Notice>
            ) : null}
            <View className="flex-row flex-wrap gap-2">
              <ControlPill
                variant="pill"
                label={snapshot.session.pending ? "Retry exact save" : "Save"}
                disabled={
                  !writable ||
                  !snapshot.session.hydrated ||
                  snapshot.structureBlocked ||
                  snapshot.loading ||
                  snapshot.error !== null ||
                  editorState.busy !== null ||
                  editorState.focus !== null ||
                  snapshot.session.status === "conflict" ||
                  !!snapshot.session.recoveryReason ||
                  !!nativeState?.blocked ||
                  !!nativeState?.observed.composing ||
                  (!snapshot.session.dirty && !snapshot.session.pending)
                }
                onPress={() => void editing.save()}
              />
              <ControlPill
                variant="pill"
                label="Discard local draft"
                disabled={
                  !writable ||
                  !snapshot.session.hydrated ||
                  snapshot.structureBlocked ||
                  snapshot.loading ||
                  snapshot.error !== null ||
                  editorState.busy !== null ||
                  editorState.focus !== null ||
                  !!snapshot.session.pending ||
                  (!snapshot.session.dirty && snapshot.session.status !== "conflict")
                }
                onPress={() =>
                  Dialog.confirm({
                    title: "Discard this local draft?",
                    message:
                      "Replace this loaded draft with the current saved first window. Unloaded blocks are untouched. A pending save must be resolved first.",
                    confirmText: "Discard local draft",
                    destructive: true,
                    onConfirm: () => void editing.discard(),
                  })
                }
              />
              {snapshot.session.persistenceError !== null && snapshot.session.hydrated ? (
                <ControlPill
                  variant="pill"
                  label="Retry local storage"
                  disabled={editorState.busy !== null}
                  onPress={() => void editing.retryPersistence()}
                />
              ) : null}
            </View>
            {focus ? (
              <View className="gap-2">
                <Text className="text-base font-bold text-foreground">
                  Editing {focus.publication.block.type}
                </Text>
                <SpacesNativeBlockEditor
                  key={focus.token}
                  publication={focus.publication}
                  editable={editable}
                  onDone={() => editing.finish(owner, focus.token)}
                />
                <ControlPill
                  variant="pill"
                  label="Discard unpublished input"
                  disabled={
                    !writable || editorState.busy !== null || snapshot.session.pending !== null
                  }
                  onPress={() =>
                    Dialog.confirm({
                      title: "Discard unpublished input?",
                      message:
                        "Keep the page draft already retained on this device. Text held only by this native input will be lost. Pending saves must be resolved first.",
                      confirmText: "Discard unpublished input",
                      destructive: true,
                      onConfirm: () => void editing.discardInput(owner, focus.token),
                    })
                  }
                />
                <Notice>
                  Finish this input before scrolling or editing another block. Done editing retains
                  the local draft; Save sends it.
                </Notice>
              </View>
            ) : editorState.focus ? (
              <Notice>This page is being edited in another open view.</Notice>
            ) : null}
            {snapshot.session.recoveryReason ? (
              <Notice>
                This older draft cannot be retried automatically. It remains on this device.
              </Notice>
            ) : null}
            {location &&
            snapshot.session.hydrated &&
            snapshot.session.baseRevision !== location.page.revision ? (
              <Notice>
                The saved page has a different revision from this local draft. Refreshing will not
                replace your draft.
              </Notice>
            ) : null}
            {snapshot.loading ? (
              <Notice>Loading page…</Notice>
            ) : snapshot.error ? (
              <Notice>{snapshot.error}</Notice>
            ) : null}
            {target.blockId &&
            location &&
            !blocks.some((block) => block.id === currentTarget.blockId) ? (
              <Notice>
                The linked block is not in this window. Use First or Next to browse bounded windows;
                it may have moved or become unavailable.
              </Notice>
            ) : null}
            <View className="flex-row flex-wrap gap-2">
              <ControlPill
                variant="pill"
                label="Library"
                disabled={editorState.focus !== null}
                onPress={() =>
                  navigation.push("SpacesLibrary", {
                    environmentId: target.environmentId,
                    spaceId: currentTarget.spaceId,
                  })
                }
              />
              <ControlPill
                variant="pill"
                label="First / refresh"
                disabled={
                  snapshot.loading || editorState.focus !== null || editorState.busy !== null
                }
                onPress={() => void reader.first()}
              />
              <ControlPill
                variant="pill"
                label="Next blocks"
                disabled={
                  snapshot.loading ||
                  editorState.focus !== null ||
                  editorState.busy !== null ||
                  !snapshot.window?.nextCursor
                }
                onPress={() => void reader.next()}
              />
            </View>
          </View>
        }
        ListEmptyComponent={
          !snapshot.loading && location ? (
            <Notice>
              {snapshot.window?.nextCursor
                ? "No blocks in this window. Continue to the next window."
                : "No blocks in this window."}
            </Notice>
          ) : undefined
        }
        renderItem={({ item }) => (
          <View>
            <SpaceBlockReader
              block={item}
              target={currentTarget}
              depth={blockDepth(item, blocks)}
              selected={item.id === currentTarget.blockId}
              onOpen={(next) => {
                if (access.current() && !editorState.focus)
                  navigation.push("SpacesPage", {
                    environmentId: next.environmentId,
                    spaceId: next.spaceId,
                    pageId: next.pageId,
                    ...(next.blockId ? { block: next.blockId } : {}),
                  });
              }}
            />
            <View className="flex-row gap-2 px-4 pb-3">
              {nativeDocumentForSpaceBlock(item) ? (
                <>
                  <ControlPill
                    variant="pill"
                    label="Edit text"
                    disabled={
                      !editable ||
                      !spacesNativeEditorAvailable ||
                      editorState.focus !== null ||
                      editorState.busy === "discard"
                    }
                    onPress={() => {
                      try {
                        editing.focus(owner, item.id);
                        setActionError(null);
                      } catch (cause) {
                        setActionError(
                          cause instanceof Error ? cause.message : "Could not edit this block",
                        );
                        return;
                      }
                      list.current?.scrollToOffset({ offset: 0, animated: false });
                    }}
                  />
                  {item.type === "todo_item" ? (
                    <ControlPill
                      variant="pill"
                      label="Toggle to-do"
                      disabled={
                        !editable || editorState.focus !== null || editorState.busy === "discard"
                      }
                      onPress={() => {
                        try {
                          editing.toggleTodo(item.id);
                          setActionError(null);
                        } catch (cause) {
                          setActionError(
                            cause instanceof Error ? cause.message : "Could not toggle this to-do",
                          );
                        }
                      }}
                    />
                  ) : null}
                </>
              ) : (
                <Text className="text-sm text-foreground-muted">
                  Edit on desktop · original content retained
                </Text>
              )}
            </View>
          </View>
        )}
      />
    </View>
  );
}
