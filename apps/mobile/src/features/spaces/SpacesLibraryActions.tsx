import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { canBrowseSpaces } from "@t2code/client-runtime/state/spaces";
import type { SpaceRootReorder } from "@t2code/client-runtime/spaces";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceId, SpacePageSummary, SpaceSummary } from "@t2code/contracts/spaces";
import { useEffect, useState, useSyncExternalStore } from "react";
import { FlatList, Modal, TextInput, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import * as Dialog from "../../components/ui/Dialog";
import { useEnvironmentQuery } from "../../state/query";
import {
  getMobileSpaceStructure,
  spacesEnvironment,
  useSpacesReadAccess,
} from "../../state/spaces";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";

type Intent =
  | { kind: "createSpace" }
  | { kind: "createPage" | "renameSpace"; space: SpaceSummary }
  | { kind: "renamePage" | "child" | "move"; page: SpacePageSummary };
interface Props {
  readonly environmentId: EnvironmentId;
  readonly spaceId?: SpaceId;
  readonly page?: SpacePageSummary;
  readonly current?: () => boolean;
  readonly blocked?: boolean;
  readonly statusOnly?: boolean;
}
function ownerResult(environmentId: EnvironmentId) {
  try {
    return { owner: getMobileSpaceStructure(environmentId), error: null };
  } catch (cause) {
    return {
      owner: null,
      error: cause instanceof Error ? cause.message : "Structural recovery unavailable",
    };
  }
}
export function SpacesLibraryActions(props: Props) {
  const [result] = useState(() => ownerResult(props.environmentId));
  return result.owner ? (
    <Actions {...props} owner={result.owner} />
  ) : (
    <Text accessibilityRole="alert" className="p-4 text-destructive">
      {result.error}
    </Text>
  );
}
function Actions({
  environmentId,
  spaceId,
  page,
  current,
  blocked = false,
  statusOnly = false,
  owner,
}: Props & { owner: SpaceRootReorder }) {
  const navigation = useNavigation<NativeStackNavigationProp<ReactNavigation.RootParamList>>();
  const access = useSpacesReadAccess(environmentId);
  const snapshot = useSyncExternalStore(owner.subscribe, owner.getSnapshot);
  const [intent, setIntent] = useState<Intent | null>(null);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [destinationSpace, setDestinationSpace] = useState<SpaceId | null>(null);
  const [movePhase, setMovePhase] = useState<"source" | "destination">("source");
  const createSpace = useAtomValue(spacesEnvironment.createSpace.permissionAtom(environmentId));
  const renameSpace = useAtomValue(spacesEnvironment.renameSpace.permissionAtom(environmentId));
  const createPage = useAtomValue(spacesEnvironment.createPage.permissionAtom(environmentId));
  const renamePage = useAtomValue(spacesEnvironment.updatePage.permissionAtom(environmentId));
  const createChild = useAtomValue(spacesEnvironment.createChild.permissionAtom(environmentId));
  const movePage = useAtomValue(spacesEnvironment.movePage.permissionAtom(environmentId));
  const trashPage = useAtomValue(spacesEnvironment.trashPage.permissionAtom(environmentId));
  const restorePage = useAtomValue(spacesEnvironment.restorePage.permissionAtom(environmentId));
  const readable = canBrowseSpaces(access.availability) && access.current();
  const writable = readable && access.availability === "writable";
  const allowedContext = () => access.current() && (!current || current());
  const metadata = useEnvironmentQuery(
    readable && spaceId && !page && !statusOnly
      ? spacesEnvironment.pages({ environmentId, input: { environmentId, spaceId, limit: 1 } })
      : null,
  );
  const space = !metadata.isPending && access.current() ? metadata.data?.space : undefined;
  const pending = snapshot.journal.pending;
  const disabled =
    blocked || !writable || !snapshot.hydrated || snapshot.busy || !!pending || !allowedContext();
  const structural = access.capability?.version === 2;
  const run = (work: Promise<unknown>) => {
    setError(null);
    void work.catch((cause: unknown) =>
      setError(cause instanceof Error ? cause.message : "Could not update Spaces"),
    );
  };
  // oxlint-disable-next-line t2code/react-effect-budget -- Hydrate the environment's durable structural journal before offering mutations or recovery.
  useEffect(() => {
    void owner.hydrate().catch(() => {});
  }, [owner]);
  function choose(value: Intent, initial = "") {
    if (disabled) return;
    setTitle(initial);
    setIntent(value);
    setError(null);
    setMovePhase("source");
    setDestinationSpace(null);
  }
  const permitted =
    intent?.kind === "createSpace"
      ? createSpace
      : intent?.kind === "renameSpace"
        ? renameSpace
        : intent?.kind === "createPage"
          ? createPage
          : intent?.kind === "renamePage"
            ? renamePage
            : intent?.kind === "child"
              ? createChild
              : movePage;
  function submit() {
    if (!intent || disabled || !permitted || !allowedContext()) return;
    let work: Promise<void>;
    switch (intent.kind) {
      case "createSpace":
        work = owner.createSpace(title);
        break;
      case "renameSpace":
        work = owner.renameSpace(intent.space, title);
        break;
      case "createPage":
        work = owner.createRootPage(intent.space, title);
        break;
      case "renamePage":
        work = owner.renamePage(intent.page, title);
        break;
      case "child":
        work = owner.createChild(title, {
          pageId: intent.page.id,
          parentId: null,
          beforeBlockId: null,
        });
        break;
      case "move":
        return;
    }
    run(
      work.then(() => {
        if (!owner.getSnapshot().journal.pending) setIntent(null);
      }),
    );
  }
  const history = snapshot.journal.history;
  const inverseAllowed =
    history &&
    history.operation !== "moveBlocks" &&
    ("destination" in history
      ? movePage
      : access.capability?.features?.recovery === true &&
        (history.operation === "trashPage" ? trashPage : restorePage));
  const result = snapshot.libraryResult;
  const bodyReady =
    intent?.kind === "child" &&
    snapshot.body?.pageId === intent.page.id &&
    snapshot.body.nextCursor === null;
  const sourceReady = intent?.kind === "move" && snapshot.position?.pageId === intent.page.id;
  const destination =
    snapshot.window?.space.id === destinationSpace && snapshot.parentPageId === null
      ? snapshot.window
      : null;
  const message =
    error ??
    (snapshot.error instanceof Error
      ? snapshot.error.message
      : snapshot.error
        ? "Structural recovery failed; existing data is retained"
        : null);
  function confirmMove(beforePageId: SpacePageSummary["id"] | null, label: string) {
    if (intent?.kind !== "move" || !destinationSpace || disabled || !movePage || !allowedContext())
      return;
    const sourceId = intent.page.id;
    const targetSpace = destinationSpace;
    Dialog.confirm({
      title: "Move page to this root placement?",
      message: label,
      confirmText: "Move page",
      onConfirm: () => {
        if (allowedContext())
          run(
            owner.move(sourceId, targetSpace, beforePageId).then(() => {
              if (!owner.getSnapshot().journal.pending) setIntent(null);
            }),
          );
      },
    });
  }
  return (
    <View className="gap-2 p-4">
      {!snapshot.hydrated ? (
        <Text className="text-foreground-muted">Loading structural recovery…</Text>
      ) : null}
      {message ? (
        <Text accessibilityRole="alert" className="text-destructive">
          {message}
        </Text>
      ) : null}
      {snapshot.notice ? (
        <Text className="text-sm text-foreground-muted">{snapshot.notice}</Text>
      ) : null}
      {pending ? (
        <View className="gap-2">
          <Text className="text-foreground">
            {pending.conflict
              ? "A known conflict is retained. Inspect explicitly before another operation."
              : "An exact operation is retained. Recover its receipt before making another library change."}
          </Text>
          <ControlPill
            variant="pill"
            label={pending.conflict ? "Inspect new intent" : "Recover exact operation"}
            disabled={snapshot.busy || !readable || (pending.conflict && !writable)}
            onPress={() =>
              pending.conflict
                ? Dialog.confirm({
                    title: "Inspect a new intent?",
                    message:
                      "The previous operation has a definite conflict. Clear that attempted intent and choose current details again.",
                    confirmText: "Inspect again",
                    onConfirm: () => run(owner.reinspect()),
                  })
                : run(owner.recover())
            }
          />
        </View>
      ) : null}
      {!snapshot.hydrated && message ? (
        <ControlPill
          variant="pill"
          label="Retry journal load"
          disabled={!readable || snapshot.busy}
          onPress={() => run(owner.hydrate())}
        />
      ) : null}
      {!statusOnly ? (
        <>
          <View className="flex-row flex-wrap gap-2">
            {page ? (
              <>
                <ControlPill
                  variant="pill"
                  label="Rename page"
                  disabled={disabled || !renamePage || !!page.trash}
                  onPress={() => choose({ kind: "renamePage", page }, page.title)}
                />
                <ControlPill
                  variant="pill"
                  label="Create child page"
                  disabled={disabled || !structural || !createChild || !!page.trash}
                  onPress={() => choose({ kind: "child", page })}
                />
                <ControlPill
                  variant="pill"
                  label="Move page to root"
                  disabled={disabled || !structural || !movePage || !!page.trash}
                  onPress={() => choose({ kind: "move", page })}
                />
              </>
            ) : (
              <>
                <ControlPill
                  variant="pill"
                  label="Create space"
                  disabled={disabled || !createSpace}
                  onPress={() => choose({ kind: "createSpace" })}
                />
                <ControlPill
                  variant="pill"
                  label="Create root page"
                  disabled={disabled || !createPage || !space}
                  onPress={() => {
                    if (space) choose({ kind: "createPage", space });
                  }}
                />
                <ControlPill
                  variant="pill"
                  label="Rename space"
                  disabled={disabled || !renameSpace || !space}
                  onPress={() => {
                    if (space) choose({ kind: "renameSpace", space }, space.title);
                  }}
                />
                {metadata.error ? (
                  <ControlPill
                    variant="pill"
                    label="Refresh space details"
                    disabled={!readable}
                    onPress={() => metadata.refresh()}
                  />
                ) : null}
              </>
            )}
          </View>
          {space?.isDefault ? (
            <Text className="text-sm text-foreground-muted">
              Default space. Spaces cannot be deleted here.
            </Text>
          ) : null}
          <View className="flex-row flex-wrap gap-2">
            <ControlPill
              variant="pill"
              label="Undo placement"
              disabled={disabled || !structural || !inverseAllowed || history?.direction !== "undo"}
              onPress={() => run(owner.compensate("undo"))}
            />
            <ControlPill
              variant="pill"
              label="Redo placement"
              disabled={disabled || !structural || !inverseAllowed || history?.direction !== "redo"}
              onPress={() => run(owner.compensate("redo"))}
            />
          </View>
          {!history ? (
            <Text className="text-sm text-foreground-muted">
              Undo is unavailable for metadata changes or an unproven inverse.
            </Text>
          ) : null}
          {result?.page && readable ? (
            <ControlPill
              variant="pill"
              label={`Open ${result.page.title || "page"}`}
              onPress={() =>
                navigation.push("SpacesPage", {
                  environmentId,
                  spaceId: result.page!.spaceId,
                  pageId: result.page!.id,
                })
              }
            />
          ) : null}
          {result?.space && !result.page && readable ? (
            <ControlPill
              variant="pill"
              label={`Open ${result.space.title || "space"}`}
              onPress={() =>
                navigation.push("SpacesLibrary", { environmentId, spaceId: result.space!.id })
              }
            />
          ) : null}
        </>
      ) : null}
      <Modal
        visible={intent !== null && readable}
        transparent
        animationType="none"
        onRequestClose={() => {
          if (!snapshot.busy) setIntent(null);
        }}
      >
        <View className="flex-1 justify-center bg-black/40">
          <View className="m-4 max-h-[85%] gap-3 rounded-xl bg-background p-4">
            <Text accessibilityRole="header" className="text-lg font-bold text-foreground">
              {intent?.kind === "move" ? "Move page to root" : "Space library change"}
            </Text>
            {message ? (
              <Text accessibilityRole="alert" className="text-destructive">
                {message}
              </Text>
            ) : null}
            {pending ? (
              <Text className="text-foreground-muted">
                Close this form and recover the exact retained operation.
              </Text>
            ) : intent?.kind === "move" ? (
              <>
                {movePhase === "source" ? (
                  <>
                    <Text className="text-foreground">
                      Prove the page’s current position and successor before choosing a destination.
                    </Text>
                    <ControlPill
                      variant="pill"
                      label="Load source ownership"
                      disabled={disabled}
                      onPress={() => run(owner.loadSource(intent.page.id))}
                    />
                    <ControlPill
                      variant="pill"
                      label="First source roots"
                      disabled={disabled}
                      onPress={() => run(owner.browse(intent.page.spaceId, intent.page.id))}
                    />
                    <ControlPill
                      variant="pill"
                      label="Next source roots"
                      disabled={
                        disabled ||
                        snapshot.window?.space.id !== intent.page.spaceId ||
                        !snapshot.window.nextCursor
                      }
                      onPress={() => run(owner.browse(intent.page.spaceId, intent.page.id, true))}
                    />
                    <Text className="text-sm text-foreground-muted">
                      {sourceReady
                        ? "Source position is proven."
                        : "Root pages need their visible successor or the final root window. Nested sources need a complete bounded parent body."}
                    </Text>
                    <ControlPill
                      variant="pill"
                      label="Choose destination space"
                      disabled={disabled || !sourceReady}
                      onPress={() => {
                        setMovePhase("destination");
                        run(owner.browseSpaces());
                      }}
                    />
                  </>
                ) : (
                  <>
                    <View className="flex-row gap-2">
                      <ControlPill
                        variant="pill"
                        label="First spaces"
                        disabled={disabled}
                        onPress={() => run(owner.browseSpaces())}
                      />
                      <ControlPill
                        variant="pill"
                        label="Next spaces"
                        disabled={disabled || !snapshot.spaces?.nextCursor}
                        onPress={() => run(owner.browseSpaces(true))}
                      />
                    </View>
                    <FlatList
                      renderScrollComponent={NativeScrollView}
                      data={snapshot.spaces?.items ?? []}
                      keyExtractor={(item) => item.id}
                      style={{ maxHeight: 120 }}
                      renderItem={({ item }) => (
                        <ControlPill
                          variant="pill"
                          label={item.title || "Untitled space"}
                          disabled={disabled}
                          onPress={() => {
                            setDestinationSpace(item.id);
                            run(owner.browse(item.id, intent.page.id));
                          }}
                        />
                      )}
                    />
                    {destination ? (
                      <>
                        <View className="flex-row gap-2">
                          <ControlPill
                            variant="pill"
                            label="First destination roots"
                            disabled={disabled}
                            onPress={() => run(owner.browse(destination.space.id, intent.page.id))}
                          />
                          <ControlPill
                            variant="pill"
                            label="Next destination roots"
                            disabled={disabled || !destination.nextCursor}
                            onPress={() =>
                              run(owner.browse(destination.space.id, intent.page.id, true))
                            }
                          />
                        </View>
                        <FlatList
                          renderScrollComponent={NativeScrollView}
                          data={destination.items.filter((item) => item.id !== intent.page.id)}
                          keyExtractor={(item) => item.id}
                          style={{ maxHeight: 160 }}
                          ListEmptyComponent={
                            <Text className="text-foreground-muted">
                              {destination.nextCursor
                                ? "No roots in this window; continue explicitly."
                                : "No other roots in this window."}
                            </Text>
                          }
                          renderItem={({ item }) => (
                            <ControlPill
                              variant="pill"
                              label={`Before ${item.title || "untitled page"}`}
                              disabled={disabled}
                              onPress={() =>
                                confirmMove(
                                  item.id,
                                  `Before ${item.title || "untitled page"} in ${destination.space.title}`,
                                )
                              }
                            />
                          )}
                        />
                        <ControlPill
                          variant="pill"
                          label="At end of this space"
                          disabled={disabled || destination.nextCursor !== null}
                          onPress={() =>
                            confirmMove(null, `At the end of ${destination.space.title}`)
                          }
                        />
                      </>
                    ) : (
                      <Text className="text-foreground-muted">
                        Choose a space from this bounded window.
                      </Text>
                    )}
                  </>
                )}
              </>
            ) : (
              <>
                <TextInput
                  accessibilityLabel="Title"
                  value={title}
                  onChangeText={setTitle}
                  editable={writable && !snapshot.busy && !pending}
                  maxLength={Math.min(1024, access.capability?.limits.maxTitleBytes ?? 256)}
                  placeholder="Title"
                  className="rounded-lg border border-border p-3 text-foreground"
                />
                {intent?.kind === "child" ? (
                  <>
                    <Text className="text-foreground-muted">
                      Append a child page only after the complete parent body is loaded. Partial
                      bodies are unavailable here.
                    </Text>
                    <ControlPill
                      variant="pill"
                      label="Load complete parent"
                      disabled={disabled}
                      onPress={() => run(owner.loadBody(intent.page.id))}
                    />
                    {snapshot.body?.pageId === intent.page.id &&
                    snapshot.body.nextCursor !== null ? (
                      <Text className="text-destructive">
                        This parent is partial. No child will be created.
                      </Text>
                    ) : null}
                  </>
                ) : null}
                <ControlPill
                  variant="pill"
                  label={
                    intent?.kind === "renamePage" || intent?.kind === "renameSpace"
                      ? "Confirm rename"
                      : "Create"
                  }
                  disabled={disabled || !permitted || (intent?.kind === "child" && !bodyReady)}
                  onPress={submit}
                />
              </>
            )}
            <ControlPill
              variant="pill"
              label={pending ? "Close" : "Cancel"}
              disabled={snapshot.busy}
              onPress={() => setIntent(null)}
            />
          </View>
        </View>
      </Modal>
    </View>
  );
}
