import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceSearchWindow } from "@t2code/client-runtime/spaces";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Switch, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { useSpacesReferenceController } from "../../state/spaces";

const messages = {
  idle: "Type a search query after @.",
  "invalid-query": "Search exceeds the byte or term limit.",
  unsupported: "Compatible Spaces search is unavailable.",
  unavailable: "Results changed or became unavailable. Retry explicitly.",
  building: "The search index is building. Retry when ready.",
  error: "Search failed. Retry explicitly.",
};

export function ComposerSpacePicker({
  environmentId,
  kind,
  query,
  onSelect,
  onCancel,
}: {
  environmentId: EnvironmentId;
  kind: "page" | "block";
  query: string;
  onSelect: (
    window: Extract<SpaceSearchWindow, { status: "ready" }>,
    index: number,
    includeChildPages: boolean,
  ) => boolean;
  onCancel: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const owner = useSpacesReferenceController(environmentId, attempt);
  const [includeChildPages, setIncludeChildPages] = useState(false);
  const [state, setState] = useState<{
    owner: typeof owner;
    query: string;
    window: SpaceSearchWindow | null;
    busy: boolean;
    error?: string;
  } | null>(null);
  // oxlint-disable-next-line t2code/react-effect-budget -- The canonical controller owns bounded transport; typing replaces its pending query and unmount invalidates publication.
  useEffect(() => {
    if (!owner?.canCapture() || !owner.canSearch()) return;
    let active = true;
    void owner.search(query).then((window) => {
      if (active) setState({ owner, query, window, busy: false });
    });
    return () => {
      active = false;
      owner.invalidate();
    };
  }, [owner, query]);
  const saved = state?.owner === owner && state.query === query ? state : null;
  const window = saved?.window;
  const ready = window?.status === "ready" && window.current() ? window : null;
  const permitted = owner?.canCapture() && owner.canSearch();
  const busy = permitted && (!saved || saved.busy);
  async function next() {
    if (!ready?.current() || !owner?.canCapture() || saved?.busy) return;
    setState({ owner, query, window: ready, busy: true });
    const result = await ready.next();
    if (owner.current()) setState({ owner, query, window: result, busy: false });
  }
  return (
    <View className="gap-2 px-3 py-2">
      <Text className="font-t2-medium text-foreground">
        {kind === "page" ? "Pages" : "Blocks"} · captured when sent
      </Text>
      <View className="flex-row items-center justify-between gap-2">
        <Text className="text-xs text-foreground-muted">Include child pages</Text>
        <Switch
          accessibilityLabel="Include child pages in selection"
          value={includeChildPages}
          onValueChange={setIncludeChildPages}
        />
      </View>
      {!permitted ? (
        <Text className="text-xs text-foreground-muted">
          Page/Block selection requires a live compatible connection, read permission, inline
          context, search and context-capture support.
        </Text>
      ) : busy ? (
        <Text className="text-xs text-foreground-muted">Searching…</Text>
      ) : window?.status !== "ready" ? (
        <Text className="text-xs text-foreground-muted">{messages[window?.status ?? "idle"]}</Text>
      ) : null}
      {ready && !busy ? (
        <ScrollView style={{ maxHeight: 180 }} keyboardShouldPersistTaps="always">
          {ready.result.items.map((hit, index) =>
            (hit.blockId ? "block" : "page") === kind ? (
              <Pressable
                accessibilityRole="button"
                key={JSON.stringify([hit.page.id, hit.blockId, index])}
                className="gap-1 py-2"
                onPress={() => {
                  if (!onSelect(ready, index, includeChildPages))
                    setState({
                      owner,
                      query,
                      window: ready,
                      busy: false,
                      error: "Selection changed or this draft is no longer current. Search again.",
                    });
                }}
              >
                <Text className="text-foreground">
                  {hit.page.title || "Untitled page"} · {kind}
                </Text>
                <Text numberOfLines={2} className="text-xs text-foreground-muted">
                  {hit.snippet}
                </Text>
              </Pressable>
            ) : null,
          )}
          {!ready.result.items.some((hit) => (hit.blockId ? "block" : "page") === kind) ? (
            <Text className="text-xs text-foreground-muted">
              No {kind} results in this window.
              {ready.result.nextCursor ? " Next results continues." : " Search has ended."}
            </Text>
          ) : null}
        </ScrollView>
      ) : null}
      {saved?.error ? (
        <Text accessibilityRole="alert" className="text-xs text-destructive">
          {saved.error}
        </Text>
      ) : null}
      <View className="flex-row flex-wrap gap-2">
        <ControlPill
          variant="pill"
          label="Next results"
          disabled={busy || !ready?.result.nextCursor || !permitted}
          onPress={() => void next()}
        />
        <ControlPill
          variant="pill"
          label="Retry search"
          onPress={() => setAttempt((value) => value + 1)}
        />
        <ControlPill variant="pill" label="Back to @ choices" onPress={onCancel} />
      </View>
    </View>
  );
}
