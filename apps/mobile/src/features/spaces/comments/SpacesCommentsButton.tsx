import { StackActions, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { EnvironmentId } from "@t2code/contracts";
import { commentsSupported, groupSpaceCommentThreads } from "@t2code/client-runtime/spaces";
import type { SpacePageId } from "@t2code/contracts/spaces";
import { useState } from "react";

import { ControlPill } from "../../../components/ui/ControlPill";
import { useEnvironmentQuery } from "../../../state/query";
import { spacesEnvironment, useSpacesReadAccess } from "../../../state/spaces";
import { SpacesCommentsSheet } from "./SpacesCommentsSheet";

/** Header button with the page's open comment count; absent when the environment has no comments. */
export function SpacesCommentsButton(props: {
  readonly environmentId: EnvironmentId;
  readonly pageId: SpacePageId;
}) {
  const { environmentId, pageId } = props;
  const navigation = useNavigation<NativeStackNavigationProp<ReactNavigation.RootParamList>>();
  const access = useSpacesReadAccess(environmentId);
  const supported = commentsSupported(access.capability);
  const query = useEnvironmentQuery(
    supported
      ? spacesEnvironment.comments.list({
          environmentId,
          input: { environmentId, pageId, status: "open" },
        })
      : null,
  );
  const [open, setOpen] = useState(false);
  if (!supported) return null;
  const count = query.data ? groupSpaceCommentThreads(query.data.threads).openCount : 0;
  return (
    <>
      <ControlPill
        variant="pill"
        icon="text.bubble"
        label={count > 0 ? `Comments (${count})` : "Comments"}
        onPress={() => setOpen(true)}
      />
      {open ? (
        <SpacesCommentsSheet
          environmentId={environmentId}
          pageId={pageId}
          onClose={() => setOpen(false)}
          onOpenThread={(threadEnvironmentId, threadId) => {
            setOpen(false);
            navigation.dispatch(
              StackActions.push("Thread", { environmentId: threadEnvironmentId, threadId }),
            );
          }}
        />
      ) : null}
    </>
  );
}
