import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useNavigation, usePreventRemove } from "@react-navigation/native";
import { canBrowseSpaces } from "@t2code/client-runtime/state/spaces";
import {
  isSpaceDatabaseBlock,
  type SpacePageNavigationTarget,
} from "@t2code/client-runtime/spaces";
import { SpacesCoreBlockControls, SpacesCoreBlockDelete } from "./SpacesCoreBlockControls";
import type { SpaceBlock } from "@t2code/contracts/spaces";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
// oxlint-disable-next-line eslint/no-restricted-imports -- the block editor keeps every row mounted for retained native input and maps VirtualizedList-only props
import { FlatList, View } from "react-native";
import { appAtomRegistry } from "../../state/atom-registry";
import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import {
  acquireSpacesPageReader,
  spacesEnvironment,
  createSpacesImageViewer,
  getMobileSpaceUploads,
  useSpacesReadAccess,
} from "../../state/spaces";
import { type SpacesReadAccess, spacesAvailabilityMessage } from "./reader";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { SpacesHeavyMediaViewer } from "./SpacesHeavyMediaViewer";
import { SpacesImageUploadControls } from "./SpacesImageUploadControls";
import { SpacesImageViewer } from "./SpacesImageViewer";
import { SpaceBlockReader } from "./SpaceBlockReader";
import { SpacesLibraryActions } from "./SpacesLibraryActions";
import { nativeDocumentForSpaceBlock } from "./nativeSpacesAdapter";
import { SpacesNativeBlockEditor, spacesNativeEditorAvailable } from "./SpacesNativeBlockEditor";
import { SpacesReferenceOpen } from "./SpacesReferences";
import { MobileSpaceReferenceNavigation } from "./references";
import * as Dialog from "../../components/ui/Dialog";
import { Notice, AccessNotice } from "./spacesScreenSupport";
import { SpacesSyncedRef } from "./SpacesSyncedRef";
import {
  isMobileReadOnlyBlock,
  syncedRefSource,
  visibleSpaceBlocks,
  type VisibleSpaceBlock,
} from "./blockVisibility";
import { SpacesDatabaseBlock } from "./databases/SpacesDatabaseBlock";
import { SpacesRowProperties } from "./databases/SpacesRowProperties";

type PageLease = Awaited<ReturnType<typeof acquireSpacesPageReader>>;

export function PageReader({ target }: { target: SpacePageNavigationTarget }) {
  const access = useSpacesReadAccess(target.environmentId);
  const ownedLease = useRef<PageLease | null>(null);
  const [attempt, setAttempt] = useState(0);
  const stamp = useMemo(() => ({ target, access, attempt }), [target, access, attempt]);
  const [view, setView] = useState<{
    stamp: typeof stamp;
    lease: PageLease | null;
    error: string | null;
  } | null>(null);
  // oxlint-disable-next-line t2code/no-unreasoned-state-sync -- Acquire the shared remote document owner and release only this view's lease on navigation or connection changes.
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
  // oxlint-disable-next-line t2code/no-unreasoned-state-sync -- Retain a mounted document through access changes; only route removal releases its lease.
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
  const [media] = useState(() => createSpacesImageViewer(target.environmentId));
  const [heavy] = useState(() => ({
    pdf: createSpacesImageViewer(target.environmentId, "pdf"),
    video: createSpacesImageViewer(target.environmentId, "video"),
  }));
  const [references] = useState(
    () =>
      new MobileSpaceReferenceNavigation({
        current: () =>
          navigation.isFocused() &&
          reader.editing.getSnapshot().focus === null &&
          reader.getSnapshot().location?.current() != null,
        open: (next) =>
          navigation.push("SpacesPage", {
            environmentId: next.environmentId,
            spaceId: next.spaceId,
            pageId: next.pageId,
            ...(next.blockId ? { block: next.blockId } : {}),
          }),
      }),
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const list = useRef<FlatList<VisibleSpaceBlock>>(null);
  const focus = editorState.focus?.owner === owner ? editorState.focus : null;
  const readable = canBrowseSpaces(access.availability) && access.current();
  const writable =
    readable && access.availability === "writable" && access.capability?.version === 2;
  const editable =
    writable &&
    snapshot.session.hydrated &&
    !snapshot.structureBlocked &&
    !snapshot.loading &&
    snapshot.unavailable === null &&
    snapshot.error === null &&
    (!snapshot.session.history.action || snapshot.session.pending !== null) &&
    editorState.busy !== "persist" &&
    snapshot.session.status !== "conflict" &&
    snapshot.session.persistenceError === null;
  const nativeState = editorState.focus?.publication.getSnapshot();
  const savedUndoReason = editing.compensationAvailability("undo");
  const savedRedoReason = editing.compensationAvailability("redo");
  usePreventRemove(focus !== null, () => {
    Dialog.alert(
      "Finish this block first",
      "Use Done editing to retain the complete native input before leaving. If a change was rejected, recover it or restore access first.",
    );
  });
  // oxlint-disable-next-line t2code/no-unreasoned-state-sync -- Refresh remote metadata on a connection change without replacing the mounted native input or its retained session.
  useEffect(() => {
    if (canBrowseSpaces(access.availability) && access.current()) void reader.first();
    else reader.invalidate();
  }, [reader, access]);
  const location = access.current() ? snapshot.location : null;
  const blocks = snapshot.session.hydrated ? snapshot.session.blocks : [];
  const [activePanes, setActivePanes] = useState<ReadonlyMap<string, string>>(() => new Map());
  const rows = visibleSpaceBlocks(blocks, activePanes);
  const livePageId = location?.page.id ?? target.pageId;
  // oxlint-disable-next-line t2code/no-unreasoned-state-sync -- Synchronise the open page with the server's change stream; the reader decides whether to read again.
  useEffect(() => {
    if (!canBrowseSpaces(access.availability)) return;
    return appAtomRegistry.subscribe(
      spacesEnvironment.pageLive(target.environmentId, livePageId),
      (signal) => void reader.liveRefresh(signal),
      { immediate: true },
    );
  }, [reader, access.availability, target.environmentId, livePageId]);
  const currentCoreSource = () =>
    navigation.isFocused() &&
    access.current() &&
    reader.getSnapshot().location === location &&
    location?.current() != null;
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
      <SpacesImageViewer model={media} access={access} />
      {access.capability?.version === 2 && access.capability.features?.assets === true ? (
        <SpacesImageUploadControls
          runtime={getMobileSpaceUploads()}
          reader={reader}
          writable={writable}
          current={() =>
            navigation.isFocused() &&
            access.current() &&
            reader.getSnapshot().location?.current() != null &&
            reader.editing.getSnapshot().focus === null
          }
        />
      ) : null}
      <SpacesHeavyMediaViewer model={heavy.pdf} access={access} />
      <SpacesHeavyMediaViewer model={heavy.video} access={access} />
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
        data={rows}
        keyExtractor={(row) => row.block.id}
        initialNumToRender={12}
        windowSize={5}
        scrollEnabled={editorState.focus === null}
        onScrollToIndexFailed={() =>
          setActionError(
            "The linked row is not measured yet. Scroll this loaded window manually or retry Reveal loaded block.",
          )
        }
        removeClippedSubviews={false}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <View className="gap-2 p-4">
            <Text accessibilityRole="header" className="text-xl font-bold text-foreground">
              {location?.page.icon ? `${location.page.icon} ` : ""}
              {location?.page.title || "Space page"}
            </Text>
            {location ? (
              <Text className="text-sm text-foreground-muted">
                {[
                  location.space.title,
                  ...location.ancestors.map(
                    (page) => `${page.icon ? `${page.icon} ` : ""}${page.title}`,
                  ),
                ].join(" / ")}{" "}
                · Revision {location.page.revision}
              </Text>
            ) : null}
            {location?.page.row ? (
              <SpacesRowProperties environmentId={target.environmentId} pageId={location.page.id} />
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
                window={snapshot.window ?? undefined}
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
                : snapshot.unavailable === "deleted"
                  ? "This page was permanently deleted. Retained local content is read-only. This cannot be undone."
                  : snapshot.unavailable === "trashed"
                    ? "This page is in Trash. Last loaded content and local drafts are retained read-only. Use Trash and restore above to recover it."
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
                  snapshot.unavailable !== null ||
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
                  snapshot.unavailable !== null ||
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
              <ControlPill
                variant="pill"
                label="Undo saved content"
                disabled={savedUndoReason !== null}
                onPress={() => void editing.compensate("undo")}
              />
              <ControlPill
                variant="pill"
                label="Redo saved content"
                disabled={savedRedoReason !== null}
                onPress={() => void editing.compensate("redo")}
              />
            </View>
            {spacesNativeEditorAvailable ? (
              <SpacesCoreBlockControls reader={reader} current={currentCoreSource} />
            ) : null}
            <Notice>
              {snapshot.session.history.action
                ? `Retained saved ${snapshot.session.history.action}. Use Save or Retry exact save to resolve it; the attempted change is kept.`
                : savedUndoReason === null
                  ? "Undo is available for the last saved content change."
                  : savedRedoReason === null
                    ? "Redo is available for the last saved content change."
                    : savedUndoReason}
            </Notice>
            {focus ? (
              <View className="gap-2">
                <Text className="text-base font-bold text-foreground">
                  Editing {focus.publication.block.type}
                </Text>
                <SpacesNativeBlockEditor
                  key={focus.token}
                  publication={focus.publication}
                  editable={editable}
                  assertCurrent={() => editing.assertFocused(owner, focus.token)}
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
            <SpacesReferenceOpen model={references} environmentId={target.environmentId} />
            {target.blockId && blocks.some((block) => block.id === currentTarget.blockId) ? (
              <ControlPill
                variant="pill"
                label="Reveal loaded block"
                disabled={editorState.focus !== null || !readable}
                onPress={() => {
                  const state = reader.getSnapshot();
                  if (
                    !access.current() ||
                    reader.editing.getSnapshot().focus ||
                    !state.location?.current()
                  )
                    return;
                  const index = state.session.blocks.findIndex(
                    (block) => block.id === currentTarget.blockId,
                  );
                  const handle = list.current;
                  if (index >= 0 && handle) {
                    try {
                      handle.scrollToIndex({ index, animated: false });
                    } catch {
                      setActionError(
                        "Could not reveal the linked row. Scroll this loaded window manually.",
                      );
                    }
                  }
                }}
              />
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
        renderItem={({ item: row }) => {
          const item = row.block;
          const sourceBlockId = syncedRefSource(item);
          const readOnly = isMobileReadOnlyBlock(blocks, item);
          const openImage = (block: SpaceBlock) => {
            const source = reader.getSnapshot().location;
            if (source)
              void (
                block.type === "pdf" ? heavy.pdf : block.type === "video" ? heavy.video : media
              ).open(
                block,
                () =>
                  navigation.isFocused() &&
                  !reader.editing.getSnapshot().focus &&
                  reader.getSnapshot().location === source &&
                  source.current() !== null,
              );
          };
          const open = (next: Parameters<typeof references.select>[0]) => {
            const source = reader.getSnapshot().location;
            if (access.current() && source && !reader.editing.getSnapshot().focus)
              references.select(
                next,
                () => reader.getSnapshot().location === source && source.current() !== null,
              );
          };
          return sourceBlockId ? (
            <SpacesSyncedRef
              environmentId={target.environmentId}
              sourceBlockId={sourceBlockId}
              target={currentTarget}
              depth={row.depth}
              onImage={openImage}
              onOpen={open}
            />
          ) : isSpaceDatabaseBlock(item) ? (
            location ? (
              <SpacesDatabaseBlock
                block={item}
                environmentId={target.environmentId}
                spaceId={location.page.spaceId}
                pageId={location.page.id}
                fullPage={blocks.length === 1 && !snapshot.window?.nextCursor}
              />
            ) : (
              <Notice>Loading database…</Notice>
            )
          ) : (
            <View>
              <SpacesCoreBlockDelete
                reader={reader}
                current={currentCoreSource}
                blockId={item.id}
              />
              <SpaceBlockReader
                block={item}
                tabs={row.tabs}
                onSelectPane={(paneId) =>
                  setActivePanes((held) => new Map(held).set(item.id, paneId))
                }
                onImage={openImage}
                target={currentTarget}
                depth={row.depth}
                selected={item.id === currentTarget.blockId}
                onOpen={open}
              />
              <View className="flex-row gap-2 px-4 pb-3">
                {!readOnly && nativeDocumentForSpaceBlock(item) ? (
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
                              cause instanceof Error
                                ? cause.message
                                : "Could not toggle this to-do",
                            );
                          }
                        }}
                      />
                    ) : null}
                  </>
                ) : item.type === "tabs" || item.type === "synced_block" ? null : (
                  <Text className="text-sm text-foreground-muted">
                    {readOnly
                      ? "Read-only on mobile · edit on desktop"
                      : "Edit on desktop · original content retained"}
                  </Text>
                )}
              </View>
            </View>
          );
        }}
      />
    </View>
  );
}
