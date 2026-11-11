import {
  SpaceDataSourceId,
  SpaceId,
  SpacePageId,
  type SpacePageSummary,
} from "@t2code/contracts/spaces";

const FIXTURE_SPACE = "space-1";
const FIXTURE_DATA_SOURCE = "data-source-1";
/** Pure data: the `state/spaces` mock factory imports it, so it must not pull in components. */
export const HOST_PAGE = SpacePageId.make("page-1");
const space = SpaceId.make(FIXTURE_SPACE);
const iso = "2026-01-01T00:00:00.000Z";
const summary = (id: string, title: string): SpacePageSummary => ({
  id: SpacePageId.make(id),
  spaceId: space,
  title,
  revision: 1,
  rootOrder: null,
  createdAt: iso,
  updatedAt: iso,
});

/** What the location query answers: the host page at the root, rows under it as database rows. */
export function locationFor(pageId: string) {
  const host = {
    ...summary(pageId, "Host page"),
    rootOrder: "a",
    location: { kind: "root" as const, spaceId: space, order: "a" },
  };
  const spaceSummary = {
    id: space,
    title: "Space",
    revision: 1,
    rootOrderRevision: 1,
    isDefault: true,
    createdAt: iso,
    updatedAt: iso,
  };
  if (pageId === HOST_PAGE) return { page: host, space: spaceSummary, ancestors: [] };
  const dataSourceId = SpaceDataSourceId.make(FIXTURE_DATA_SOURCE);
  return {
    page: {
      ...summary(pageId, `Task ${pageId.replace("row-", "")}`),
      row: { dataSourceId },
    },
    space: spaceSummary,
    ancestors: [{ ...host, id: HOST_PAGE }],
    row: { dataSourceId, hostPageId: HOST_PAGE },
  };
}
