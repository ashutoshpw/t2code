import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { expect, it } from "vite-plus/test";
import {
  closeAppModal,
  isSidebarUtilityPage,
  navigateToMainApp,
  startMainAppLocationTracking,
} from "./mainAppLocation";

it("classifies Spaces precisely so it cannot replace the last chat", () => {
  expect(isSidebarUtilityPage("/spaces")).toBe(true);
  expect(isSidebarUtilityPage("/spaces/remote/space/page")).toBe(true);
  expect(isSidebarUtilityPage("/spaces-extra")).toBe(false);
});

it("returns from a Spaces modal to Spaces and from Spaces to the previous chat", async () => {
  const root = createRootRoute();
  const catchAll = createRoute({ getParentRoute: () => root, path: "$" });
  const router = createRouter({
    routeTree: root.addChildren([catchAll]),
    history: createMemoryHistory({ initialEntries: ["/remote/thread"] }),
  });
  await router.load();
  const stop = startMainAppLocationTracking(router);
  const navigate = async (href: string) => {
    const fromLocation = router.state.location;
    await router.navigate({ href });
    const toLocation = router.state.location;
    // React's Transitioner supplies this public event after the destination renders.
    router.emit({
      type: "onResolved",
      fromLocation,
      toLocation,
      pathChanged: fromLocation.pathname !== toLocation.pathname,
      hrefChanged: fromLocation.href !== toLocation.href,
      hashChanged: fromLocation.hash !== toLocation.hash,
    });
  };
  try {
    await navigate("/spaces/remote/space/page?block=id");
    await navigate("/settings/beta");
    await closeAppModal(router);
    expect(router.state.location.href).toBe("/spaces/remote/space/page?block=id");
    await navigateToMainApp(router);
    expect(router.state.location.href).toBe("/remote/thread");
  } finally {
    stop();
  }
});
