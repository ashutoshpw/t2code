import { useRouter, type AnyRouter } from "@tanstack/react-router";
import type { ScopedThreadRef } from "@t2code/contracts";
import { resolveThreadRouteRef } from "../../threadRoutes";
import { SPACE_PAGE_SHARE_PAGE_PATH } from "@t2code/contracts";
import { GUEST_PAGE_PATH } from "../../guestPage";

export function isAppModalPage(pathname: string) {
  return pathname === "/settings" || pathname.startsWith("/settings/") || pathname === "/usage";
}

export function isSpacesPage(pathname: string) {
  return pathname === "/spaces" || pathname.startsWith("/spaces/");
}

export function isSidebarUtilityPage(pathname: string) {
  return (
    pathname.startsWith("/projects/") ||
    pathname === "/pull-requests" ||
    pathname === "/scheduled-tasks" ||
    isSpacesPage(pathname)
  );
}

// Shell-less pages must never replace the chat or utility page to return to.
const SHELL_LESS_PATHS = new Set([
  "/pair",
  "/connect",
  "/connect-agent",
  GUEST_PAGE_PATH,
  SPACE_PAGE_SHARE_PAGE_PATH,
]);
const locations = new WeakMap<
  AnyRouter,
  { mainAppHref: string | null; modalReturnHref: string | null; threadRef: ScopedThreadRef | null }
>();

export function startMainAppLocationTracking(router: AnyRouter): () => void {
  const state = {
    mainAppHref: null as string | null,
    modalReturnHref: null as string | null,
    threadRef: null as ScopedThreadRef | null,
  };
  locations.set(router, state);
  const record = () => {
    const { pathname, href } = router.state.location;
    if (isAppModalPage(pathname) || SHELL_LESS_PATHS.has(pathname)) return;
    state.modalReturnHref = href;
    if (!isSidebarUtilityPage(pathname)) {
      state.mainAppHref = href;
      state.threadRef = resolveThreadRouteRef(router.state.matches.at(-1)?.params ?? {});
    }
  };
  record();
  return router.subscribe("onResolved", record);
}

export function navigateToMainApp(router: AnyRouter) {
  return router.navigate({ href: locations.get(router)?.mainAppHref ?? "/" });
}

export function closeAppModal(router: AnyRouter) {
  const state = locations.get(router);
  return router.navigate({ href: state?.modalReturnHref ?? state?.mainAppHref ?? "/" });
}

export function useMainAppThreadRef() {
  return locations.get(useRouter())?.threadRef ?? null;
}

export function useNavigateToMainApp() {
  const router = useRouter();
  return () => navigateToMainApp(router);
}

export function useCloseAppModal() {
  const router = useRouter();
  return () => closeAppModal(router);
}
