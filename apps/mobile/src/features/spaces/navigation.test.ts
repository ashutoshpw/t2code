import * as NodeModule from "node:module";
import { expect, it } from "vite-plus/test";
import {
  readSpacesLibraryTarget,
  readSpacesPageTarget,
  spacesLibraryLinking,
  spacesPageLinking,
} from "./navigation";

const requireNavigation = NodeModule.createRequire(
  NodeModule.createRequire(import.meta.url).resolve("@react-navigation/native/package.json"),
);
const { getStateFromPath } = requireNavigation("@react-navigation/core") as Pick<
  typeof import("@react-navigation/native"),
  "getStateFromPath"
>;
const { StackRouter, StackActions } = requireNavigation("@react-navigation/routers") as Pick<
  typeof import("@react-navigation/native"),
  "StackRouter" | "StackActions"
>;
const screens = { Home: "", SpacesLibrary: spacesLibraryLinking, SpacesPage: spacesPageLinking };

it("opens a cold remote page link above Home, keeps its block query and goes back", () => {
  const linked = getStateFromPath("spaces/remote/old-space/page?block=stable-block", {
    initialRouteName: "Home",
    screens,
  });
  expect(linked?.routes[0]?.name).toBe("Home");
  const page = linked?.routes.at(-1);
  expect(readSpacesPageTarget(page?.params)).toEqual({
    environmentId: "remote",
    spaceId: "old-space",
    pageId: "page",
    blockId: "stable-block",
  });
  const router = StackRouter({ initialRouteName: "Home" });
  const options = { routeNames: Object.keys(screens), routeParamList: {}, routeGetIdList: {} };
  const state = router.getRehydratedState({ stale: true, routes: linked!.routes }, options);
  const back = router.getStateForAction(state, { type: "GO_BACK" }, options);
  expect(back?.routes.at(-1)?.name).toBe("Home");
});

it("pushes a library and another page without replacing the origin screen", () => {
  const router = StackRouter({ initialRouteName: "Home" });
  const options = { routeNames: Object.keys(screens), routeParamList: {}, routeGetIdList: {} };
  const home = router.getInitialState(options);
  const libraryLink = getStateFromPath("spaces/remote/default-space", {
    initialRouteName: "Home",
    screens,
  });
  const library = libraryLink?.routes.at(-1);
  expect(readSpacesLibraryTarget(library?.params)).toEqual({
    environmentId: "remote",
    spaceId: "default-space",
  });
  const opened = router.getRehydratedState(
    router.getStateForAction(home, StackActions.push(library!.name, library!.params), options)!,
    options,
  );
  const next = router.getRehydratedState(
    router.getStateForAction(
      opened,
      StackActions.push("SpacesPage", {
        environmentId: "remote",
        spaceId: "default-space",
        pageId: "child",
      }),
      options,
    )!,
    options,
  );
  const back = router.getStateForAction(next, { type: "GO_BACK" }, options)!;
  expect(back.routes.at(-1)?.key).toBe(opened.routes.at(-1)?.key);
  expect(back.routes[0]?.key).toBe(home.routes[0]?.key);
});

it("rejects malformed or oversized navigation identities before opening a reader", () => {
  expect(
    readSpacesPageTarget({ environmentId: "remote", spaceId: "space", pageId: "", block: "b" }),
  ).toBeNull();
  expect(
    readSpacesPageTarget({
      environmentId: "remote",
      spaceId: "space",
      pageId: "page",
      block: "界".repeat(86),
    }),
  ).toBeNull();
  expect(readSpacesLibraryTarget({ environmentId: 1 })).toBeNull();
  expect(readSpacesLibraryTarget({ environmentId: "x".repeat(257) })).toBeNull();
});
