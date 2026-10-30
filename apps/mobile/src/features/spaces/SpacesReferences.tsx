import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { SpaceSearchWindow } from "@t2code/client-runtime/spaces";
import type { EnvironmentId } from "@t2code/contracts";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { FlatList, TextInput, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { useSpacesReferenceController } from "../../state/spaces";
import { MobileSpaceReferenceNavigation } from "./references";

export function SpacesReferenceOpen({
  model,
  environmentId,
}: {
  model: MobileSpaceReferenceNavigation;
  environmentId: EnvironmentId;
}) {
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const [attempt, setAttempt] = useState(0);
  const destinationEnvironment = state.selection?.environmentId ?? environmentId;
  const owner = useSpacesReferenceController(destinationEnvironment, attempt);
  // oxlint-disable-next-line t2code/react-effect-budget -- Dispose pending navigation metadata when its mounted source view is removed.
  useEffect(() => model.mount(), [model]);
  if (!state.selection) return null;
  return (
    <View className="gap-2 px-4 py-2">
      <Text selectable className="text-foreground-muted">
        Selected reference · {state.selection.target.kind} ·{" "}
        {state.selection.target.kind === "page"
          ? state.selection.target.pageId
          : state.selection.target.blockId}
      </Text>
      <ControlPill
        variant="pill"
        label={state.busy ? "Resolving current source…" : "Open current source"}
        disabled={state.busy || !owner?.canResolve()}
        onPress={() => {
          if (owner) void model.open(owner, destinationEnvironment);
        }}
      />
      {!owner?.current() ? (
        <ControlPill
          variant="pill"
          label="Retry source connection"
          onPress={() => setAttempt((value) => value + 1)}
        />
      ) : null}
      {!owner?.canResolve() ? (
        <Text className="text-foreground-muted">
          Current-source navigation requires this destination environment’s read access, compatible
          connection and reference-resolution support.
        </Text>
      ) : null}
      {state.title ? (
        <Text className="text-foreground">Last resolved title: {state.title}</Text>
      ) : null}
      {state.error ? (
        <Text accessibilityRole="alert" className="text-destructive">
          {state.error}
        </Text>
      ) : null}
    </View>
  );
}

const searchMessages = {
  idle: "Enter a search query.",
  "invalid-query": "Query exceeds the supported byte or term limit.",
  unsupported: "This environment does not advertise compatible search support.",
  unavailable: "Results are stale or unavailable. Request First results again.",
  building: "Search index is building. Retry First results explicitly when ready.",
  error: "Search failed. Retry First results.",
};

export function SpacesSearch({ environmentId }: { environmentId: EnvironmentId }) {
  const navigation = useNavigation<NativeStackNavigationProp<ReactNavigation.RootParamList>>();
  const [query, setQuery] = useState("");
  const [attempt, setAttempt] = useState(0);
  const owner = useSpacesReferenceController(environmentId, attempt);
  const request = useRef(0);
  const [state, setState] = useState<{
    owner: typeof owner;
    busy: boolean;
    window: SpaceSearchWindow | null;
  } | null>(null);
  const [model] = useState(
    () =>
      new MobileSpaceReferenceNavigation({
        current: () => navigation.isFocused(),
        open: (target) =>
          navigation.push("SpacesPage", {
            environmentId: target.environmentId,
            spaceId: target.spaceId,
            pageId: target.pageId,
            ...(target.blockId ? { block: target.blockId } : {}),
          }),
      }),
  );
  const saved = state?.owner === owner ? state : null;
  const window = saved?.window;
  const ready = window?.status === "ready" && window.current() ? window : null;
  async function run(next = false) {
    if (!owner || !navigation.isFocused()) return;
    const id = ++request.current;
    setState({ owner, busy: true, window: null });
    const result = await (next && ready ? ready.next() : owner.search(query));
    if (id === request.current && navigation.isFocused() && owner.current())
      setState({ owner, busy: false, window: result });
  }
  return (
    <View className="gap-2 border-b border-border py-2">
      <Text className="px-4 text-base font-bold text-foreground">Search this environment</Text>
      <TextInput
        accessibilityLabel="Search Spaces"
        className="mx-4 rounded border border-border px-3 py-2 text-foreground"
        value={query}
        onChangeText={(value) => {
          setQuery(value);
          request.current++;
          owner?.invalidate();
          setState(null);
        }}
        onSubmitEditing={() => void run()}
        returnKeyType="search"
      />
      <View className="flex-row flex-wrap gap-2 px-4">
        <ControlPill
          variant="pill"
          label="First results"
          disabled={!owner?.current()}
          onPress={() => void run()}
        />
        <ControlPill
          variant="pill"
          label="Next results"
          disabled={saved?.busy || !ready?.result.nextCursor}
          onPress={() => void run(true)}
        />
        {!owner?.current() ? (
          <ControlPill
            variant="pill"
            label="Retry search connection"
            onPress={() => setAttempt((value) => value + 1)}
          />
        ) : null}
      </View>
      {!owner?.current() ? (
        <Text className="px-4 text-foreground-muted">
          Search requires a live compatible connection and read access.
        </Text>
      ) : null}
      {saved?.busy ? <Text className="px-4 text-foreground-muted">Searching…</Text> : null}
      {window && window.status !== "ready" ? (
        <Text
          accessibilityRole={window.status === "error" ? "alert" : undefined}
          className="px-4 text-foreground-muted"
        >
          {searchMessages[window.status]}
        </Text>
      ) : null}
      {window?.status === "ready" && !ready ? (
        <Text className="px-4 text-foreground-muted">
          Results changed. Request First results again.
        </Text>
      ) : null}
      {ready ? (
        <FlatList
          ListHeaderComponent={
            <Text className="px-4 text-foreground-muted">
              Titles and snippets belong to this search window. Open current source resolves the
              latest identity and title.
            </Text>
          }
          style={{ maxHeight: 240 }}
          data={ready.result.items}
          keyExtractor={(hit, index) => JSON.stringify([hit.page.id, hit.blockId, index])}
          ListEmptyComponent={
            <Text className="px-4 text-foreground-muted">
              {ready.result.nextCursor
                ? "No results in this window. Next results continues the bounded search."
                : "No results in this window; search has ended."}
            </Text>
          }
          renderItem={({ item, index }) => (
            <View className="gap-1 px-4 py-2">
              <Text selectable className="text-foreground">
                {item.page.icon ? `${item.page.icon} ` : ""}
                {item.page.title || "Untitled page"} · {item.blockId ? "Block" : "Page"}
              </Text>
              <Text selectable className="text-foreground-muted">
                {item.snippet}
              </Text>
              <ControlPill
                variant="pill"
                label="Select source"
                disabled={!ready.current()}
                onPress={() => {
                  const target = ready.target(index);
                  if (target) model.select({ environmentId, target }, () => ready.current());
                }}
              />
            </View>
          )}
        />
      ) : null}
      <SpacesReferenceOpen model={model} environmentId={environmentId} />
    </View>
  );
}
