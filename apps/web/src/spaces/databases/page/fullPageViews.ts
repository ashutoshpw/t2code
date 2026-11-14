import type { SpaceDatabaseView, SpaceViewId } from "@t2code/contracts/spaces";

/** The home block's tabs, plus a requested view of this database that is not among them (a linked block's view). */
export function fullPageViewIds(
  home: { readonly blockId: string; readonly viewIds?: ReadonlyArray<SpaceViewId> | undefined },
  requested: string | undefined,
  views: ReadonlyArray<SpaceDatabaseView>,
): ReadonlyArray<SpaceViewId> {
  // Servers from before home.viewIds never send it; their views name the home block as owner.
  const tabs =
    home.viewIds ??
    views.filter((view) => view.ownerBlockId === home.blockId).map((view) => view.id);
  const extra = requested === undefined ? undefined : views.find((view) => view.id === requested);
  return extra === undefined || tabs.includes(extra.id) ? tabs : [...tabs, extra.id];
}
