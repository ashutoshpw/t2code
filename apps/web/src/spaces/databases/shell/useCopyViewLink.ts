import { toastManager } from "~/components/ui/toast";
import type { SpaceViewId } from "@t2code/contracts/spaces";

import type { DatabaseModel } from "../data/useDatabaseModel";
import { useDatabasePageNavigation } from "../page/databasePageLink";

/** Copies the link to a view on the database's own page. */
export function useCopyViewLink(model: DatabaseModel) {
  const navigation = useDatabasePageNavigation();
  return (viewId: SpaceViewId) => {
    const href = navigation.href({
      environmentId: model.environmentId,
      spaceId: model.database.spaceId,
      databaseId: model.database.id,
      viewId,
    });
    if (href === null) {
      toastManager.add({ type: "error", title: "Couldn't copy link" });
      return;
    }
    void navigator.clipboard.writeText(href).then(
      () => toastManager.add({ type: "success", title: "Link copied" }),
      () => toastManager.add({ type: "error", title: "Couldn't copy link" }),
    );
  };
}
