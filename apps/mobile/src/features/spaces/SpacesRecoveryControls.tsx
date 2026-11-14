import { useAtomValue } from "@effect/atom-react";
import { canBrowseSpaces } from "@t2code/client-runtime/state/spaces";
import type { SpaceRecoveryPreview, SpaceRootReorder } from "@t2code/client-runtime/spaces";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpacePageId, SpacePageSummary } from "@t2code/contracts/spaces";
import { useState, useSyncExternalStore } from "react";
import { FlatList, Modal, TextInput, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import * as Dialog from "../../components/ui/Dialog";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { spacesEnvironment, useSpacesReadAccess } from "../../state/spaces";

export function SpacesRecoveryControls({
  environmentId,
  owner,
  page,
  current,
  blocked = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly owner: SpaceRootReorder;
  readonly page?: SpacePageSummary;
  readonly current?: () => boolean;
  readonly blocked?: boolean;
}) {
  const access = useSpacesReadAccess(environmentId);
  const snapshot = useSyncExternalStore(owner.subscribe, owner.getSnapshot);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<SpaceRecoveryPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const trashPermission = useAtomValue(spacesEnvironment.trashPage.permissionAtom(environmentId));
  const restorePermission = useAtomValue(
    spacesEnvironment.restorePage.permissionAtom(environmentId),
  );
  const purgePermission = useAtomValue(
    spacesEnvironment.permanentlyDeletePage.permissionAtom(environmentId),
  );
  const supported =
    access.capability?.version === 2 && access.capability.features?.recovery === true;
  const readable = supported && canBrowseSpaces(access.availability) && access.current();
  const writable = readable && access.availability === "writable";
  const unavailable = !snapshot.hydrated || snapshot.busy || !!snapshot.journal.pending;
  const preview = selected === snapshot.recoveryPreview ? selected : null;
  const history = snapshot.journal.history;
  const visibility = history && !("destination" in history) ? history : null;
  const pageCurrent = () => !current || current();
  const run = (work: Promise<unknown>) => {
    setError(null);
    void work.catch((cause: unknown) =>
      setError(
        cause instanceof Error ? cause.message : "Recovery failed; existing data is retained",
      ),
    );
  };
  async function inspect(
    pageId: SpacePageId,
    operation: "trash" | "restore" | "permanentlyDelete",
  ) {
    if (!readable || (operation === "trash" && (!pageCurrent() || blocked))) return;
    setSelected(null);
    setConfirmation("");
    await owner.previewRecovery(pageId, operation);
    if (access.current() && (operation !== "trash" || pageCurrent()))
      setSelected(owner.getSnapshot().recoveryPreview);
  }
  function confirm() {
    if (
      !preview ||
      unavailable ||
      !writable ||
      (preview.operation === "trash"
        ? !trashPermission || blocked || !pageCurrent()
        : preview.operation === "permanentlyDelete"
          ? !purgePermission || confirmation !== "DELETE"
          : !restorePermission)
    )
      return;
    const intent = preview;
    const permanent = intent.operation === "permanentlyDelete";
    const name =
      intent.inspection.pages.find((entry) => entry.id === intent.pageId)?.title || "Untitled page";
    Dialog.confirm({
      title: permanent
        ? `Permanently delete “${name}”?`
        : intent.operation === "trash"
          ? "Move these pages to Trash?"
          : "Restore these pages?",
      message: `${intent.pageId}: ${intent.inspection.recovery!.pageIds.length} selected page(s). ${intent.placement}${permanent ? " This cannot be undone." : " Independently trashed batches stay separate."}`,
      confirmText: permanent
        ? "Permanently delete"
        : intent.operation === "trash"
          ? "Move to Trash"
          : "Restore",
      destructive: permanent,
      onConfirm: () => {
        if (access.current() && (intent.operation !== "trash" || pageCurrent()))
          run(owner.confirmRecovery(intent, permanent));
      },
    });
  }
  if (!supported) return null;
  return (
    <View className="gap-2">
      <View className="flex-row flex-wrap gap-2">
        <ControlPill
          variant="pill"
          label="Trash and restore"
          disabled={!readable || unavailable}
          onPress={() => {
            setSelected(null);
            setConfirmation("");
            setOpen(true);
            run(owner.browseTrash());
          }}
        />
        {page && !page.trash ? (
          <ControlPill
            variant="pill"
            label="Move page to Trash"
            disabled={unavailable || !writable || !trashPermission || blocked || !pageCurrent()}
            onPress={() => {
              setOpen(true);
              run(inspect(page.id, "trash"));
            }}
          />
        ) : null}
      </View>
      <Modal
        visible={open && readable}
        transparent
        animationType="none"
        onRequestClose={() => {
          if (!snapshot.busy) {
            setOpen(false);
            setSelected(null);
          }
        }}
      >
        <View className="flex-1 justify-center bg-black/40">
          <View className="m-4 max-h-[85%] gap-3 rounded-xl bg-background p-4">
            <Text accessibilityRole="header" className="text-lg font-bold text-foreground">
              Trash and restore
            </Text>
            <Text className="text-foreground-muted">
              Inspect the current batch and ownership before confirming. Resolve affected drafts
              first. Undo changes visibility only when its inverse is proven.
            </Text>
            {error || snapshot.error ? (
              <Text accessibilityRole="alert" className="text-destructive">
                {error ??
                  (snapshot.error instanceof Error
                    ? snapshot.error.message
                    : "Recovery unavailable")}
              </Text>
            ) : null}
            {snapshot.notice ? (
              <Text className="text-foreground-muted">{snapshot.notice}</Text>
            ) : null}
            {snapshot.journal.pending ? (
              <Text className="text-foreground-muted">
                Close this form and recover the exact retained operation before another action.
              </Text>
            ) : null}
            <View className="flex-row gap-2">
              <ControlPill
                variant="pill"
                label="First trash pages"
                disabled={!readable || unavailable}
                onPress={() => {
                  setSelected(null);
                  run(owner.browseTrash());
                }}
              />
              <ControlPill
                variant="pill"
                label="Next trash pages"
                disabled={!readable || unavailable || !snapshot.trash?.nextCursor}
                onPress={() => {
                  setSelected(null);
                  run(owner.browseTrash(true));
                }}
              />
            </View>
            {snapshot.trash && !preview ? (
              <FlatList
                renderScrollComponent={NativeScrollView}
                data={snapshot.trash.items}
                keyExtractor={(item) => item.pageId}
                style={{ maxHeight: 160 }}
                ListEmptyComponent={
                  <Text className="text-foreground-muted">
                    {snapshot.trash.nextCursor
                      ? "No trash roots in this window. Next continues the list."
                      : "No trash roots in this window; this list has ended."}
                  </Text>
                }
                renderItem={({ item }) => (
                  <View className="gap-1 py-2">
                    <Text className="text-foreground">
                      {item.title || "Untitled page"} · Revision {item.revision}
                    </Text>
                    <ControlPill
                      variant="pill"
                      label="Inspect restore"
                      disabled={!readable || unavailable}
                      onPress={() => run(inspect(item.pageId, "restore"))}
                    />
                    <ControlPill
                      variant="pill"
                      label="Inspect permanent deletion…"
                      disabled={!readable || unavailable || !writable || !purgePermission}
                      onPress={() => run(inspect(item.pageId, "permanentlyDelete"))}
                    />
                  </View>
                )}
              />
            ) : null}
            {preview ? (
              <View className="gap-2">
                <Text className="text-foreground">{preview.placement}</Text>
                <FlatList
                  renderScrollComponent={NativeScrollView}
                  data={preview.inspection.recovery!.pageIds}
                  keyExtractor={(id) => id}
                  style={{ maxHeight: 120 }}
                  renderItem={({ item: id }) => (
                    <View className="gap-1 py-1">
                      <Text className="text-foreground">
                        {preview.inspection.pages.find((entry) => entry.id === id)?.title ||
                          "Untitled page"}{" "}
                        · {id}
                      </Text>
                      {preview.operation === "restore" && id !== preview.pageId ? (
                        <ControlPill
                          variant="pill"
                          label="Inspect restore starting here"
                          disabled={!readable || unavailable}
                          onPress={() => run(inspect(id, "restore"))}
                        />
                      ) : null}
                    </View>
                  )}
                />
                {preview.operation === "permanentlyDelete" ? (
                  <>
                    <Text className="text-destructive">
                      Permanently delete these {preview.inspection.recovery!.pageIds.length}{" "}
                      inspected pages, including independent batches in the current subtree. No
                      Undo. Type DELETE to continue.
                    </Text>
                    <TextInput
                      accessibilityLabel="Type DELETE to confirm permanent deletion"
                      value={confirmation}
                      onChangeText={setConfirmation}
                      autoCorrect={false}
                      autoCapitalize="characters"
                      maxLength={6}
                      editable={writable && !unavailable && purgePermission}
                      className="rounded-lg border border-border p-3 text-foreground"
                    />
                  </>
                ) : null}
                <ControlPill
                  variant="pill"
                  label={
                    preview.operation === "permanentlyDelete"
                      ? "Confirm permanent deletion…"
                      : preview.operation === "trash"
                        ? "Confirm Trash…"
                        : "Confirm restore…"
                  }
                  disabled={
                    unavailable ||
                    !writable ||
                    (preview.operation === "trash"
                      ? !trashPermission || blocked || !pageCurrent()
                      : preview.operation === "permanentlyDelete"
                        ? !purgePermission || confirmation !== "DELETE"
                        : !restorePermission)
                  }
                  onPress={confirm}
                />
              </View>
            ) : null}
            {visibility ? (
              <ControlPill
                variant="pill"
                label={`${visibility.direction === "undo" ? "Undo" : "Redo"} last visibility action`}
                disabled={
                  unavailable ||
                  !writable ||
                  (visibility.operation === "trashPage" ? !trashPermission : !restorePermission)
                }
                onPress={() => run(owner.compensate(visibility.direction))}
              />
            ) : (
              <Text className="text-foreground-muted">
                Visibility Undo is unavailable without a proven current inverse.
              </Text>
            )}
            <ControlPill
              variant="pill"
              label={snapshot.journal.pending ? "Close" : "Cancel"}
              disabled={snapshot.busy}
              onPress={() => {
                setOpen(false);
                setSelected(null);
                setConfirmation("");
              }}
            />
          </View>
        </View>
      </Modal>
    </View>
  );
}
