import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";
import { SpaceBlockId } from "@t2code/contracts/spaces";
import { validateSpacePageSearch } from "@t2code/client-runtime/spaces";

it("keeps block navigation in router search with encoded page identifiers", async () => {
  const root = createRootRoute();
  const page = createRoute({
    getParentRoute: () => root,
    path: "/spaces/$environmentId/$spaceId/$pageId",
    validateSearch: validateSpacePageSearch,
  });
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.navigate({
    to: "/spaces/$environmentId/$spaceId/$pageId",
    params: { environmentId: "remote", spaceId: "space", pageId: "page/with spaces" },
    search: { block: SpaceBlockId.make("block:id") },
  });
  expect(router.state.location.hash).toBe("");
  expect(router.state.location.search).toEqual({ block: "block:id" });
  expect(router.state.location.href).toContain("?block=");
  expect(router.state.matches.at(-1)).toMatchObject({ params: { pageId: "page/with spaces" } });
});

describe("invalid block targets", () => {
  it.each(["", 42, true, ["block"], "x".repeat(257)])(
    "drops unsupported search values",
    (block) => {
      expect(validateSpacePageSearch({ block })).toEqual({});
    },
  );
});
