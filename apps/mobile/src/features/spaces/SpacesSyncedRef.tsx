import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceBlock } from "@t2code/contracts/spaces";
import type { SpacePageNavigationTarget } from "@t2code/client-runtime/spaces";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useEnvironmentQuery } from "../../state/query";
import { spacesEnvironment } from "../../state/spaces";
import { SpaceBlockReader } from "./SpaceBlockReader";
import { syncedRefNotice, visibleSpaceBlocks } from "./blockVisibility";
import type { MobileSpaceReference } from "./references";

/** A copy of a synced block: the original's content, read-only, indented under a header. */
export function SpacesSyncedRef(props: {
  readonly environmentId: EnvironmentId;
  readonly sourceBlockId: SpaceBlock["id"];
  readonly target: SpacePageNavigationTarget;
  readonly depth: number;
  readonly onImage: (block: SpaceBlock) => void;
  readonly onOpen: (target: MobileSpaceReference) => void;
}) {
  const query = useEnvironmentQuery(
    spacesEnvironment.readSubtree({
      environmentId: props.environmentId,
      input: { environmentId: props.environmentId, blockId: props.sourceBlockId },
    }),
  );
  const result = query.data;
  const notice = result ? syncedRefNotice(result.status) : null;
  return (
    <View style={{ marginLeft: props.depth * 16 }}>
      <Text className="px-4 pt-3 text-sm text-foreground-muted">
        {result?.status === "found" ? `Synced from ${result.page.title}` : "Synced block"}
      </Text>
      {!result ? (
        <Text className="px-4 py-3 text-foreground-muted">
          {query.error ? "Could not load the original." : "Loading the original…"}
        </Text>
      ) : notice ? (
        <Text accessibilityLiveRegion="polite" className="px-4 py-3 text-foreground-muted">
          {notice}
        </Text>
      ) : result.status === "found" ? (
        <>
          {visibleSpaceBlocks(result.blocks.slice(1), new Map()).map((row) => (
            <SpaceBlockReader
              key={row.block.id}
              block={row.block}
              target={props.target}
              depth={row.depth}
              selected={false}
              onImage={props.onImage}
              onOpen={props.onOpen}
            />
          ))}
          {!result.complete ? (
            <Text className="px-4 py-3 text-sm text-foreground-muted">
              The original is longer than this preview. Open it on its page to read the rest.
            </Text>
          ) : null}
        </>
      ) : null}
    </View>
  );
}
