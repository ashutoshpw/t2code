import { withDeviceHubQuery } from "@t2code/client-runtime/device/hub-access";
import type { DesktopPreviewHostState, EnvironmentId } from "@t2code/contracts";
import { useEffect } from "react";
import { create } from "zustand";

import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { isElectron } from "~/env";
import { readPreviewStreamAccess } from "~/state/previewStream";
import { readEnvironmentSupportsServerBrowser } from "~/state/entities";
import { readPreparedConnection } from "~/state/session";

interface PreviewHostStoreState {
  readonly statusByEnvironmentId: Readonly<Record<string, DesktopPreviewHostState["status"]>>;
  readonly apply: (state: DesktopPreviewHostState) => void;
}

export const usePreviewHostStore = create<PreviewHostStoreState>()((set) => ({
  statusByEnvironmentId: {},
  apply: (state) =>
    set((current) => ({
      statusByEnvironmentId: {
        ...current.statusByEnvironmentId,
        [state.environmentId]: state.status,
      },
    })),
}));

export const readPreviewHostConnected = (environmentId: EnvironmentId): boolean =>
  usePreviewHostStore.getState().statusByEnvironmentId[environmentId] === "connected";

export function usePreviewHostConnected(environmentId: EnvironmentId): boolean {
  return usePreviewHostStore((state) => state.statusByEnvironmentId[environmentId] === "connected");
}

const UNAUTHORIZED_RETRY_MS = 3_000;

/** Environments this app currently volunteers its browser pane to. */
const desired = new Set<EnvironmentId>();
/** Environments with a connection in flight or up, mapped to the URL used. */
const started = new Set<EnvironmentId>();
let knownEnvironmentIds: readonly EnvironmentId[] = [];

const isCandidate = (environmentId: EnvironmentId): boolean => {
  if (!readEnvironmentSupportsServerBrowser(environmentId)) return false;
  const prepared = readPreparedConnection(environmentId);
  // The bundled server already owns this app's pane.
  return prepared !== null && !isDesktopLocalConnectionTarget(prepared.target);
};

const hostUrl = async (environmentId: EnvironmentId): Promise<string | null> => {
  const access = await readPreviewStreamAccess(environmentId, true);
  return access === null ? null : withDeviceHubQuery(`${access.wsBase}/host`, access);
};

const syncHosts = async (environmentIds: readonly EnvironmentId[]): Promise<void> => {
  const preview = isElectron ? window.desktopBridge?.preview : undefined;
  if (!preview?.startBrowserHost) return;
  knownEnvironmentIds = environmentIds;
  desired.clear();
  for (const environmentId of environmentIds) {
    if (isCandidate(environmentId)) desired.add(environmentId);
  }

  for (const environmentId of [...started]) {
    if (desired.has(environmentId)) continue;
    started.delete(environmentId);
    await preview.stopBrowserHost?.(environmentId).catch(() => undefined);
  }

  for (const environmentId of desired) {
    if (started.has(environmentId)) continue;
    // Claim before minting so overlapping syncs do not open two sessions.
    started.add(environmentId);
    const url = await hostUrl(environmentId);
    if (url === null || !desired.has(environmentId)) {
      started.delete(environmentId);
      continue;
    }
    await preview.startBrowserHost({ environmentId, url }).catch(() => {
      started.delete(environmentId);
    });
  }
};

const applyHostState = (state: DesktopPreviewHostState): void => {
  usePreviewHostStore.getState().apply(state);
  if (state.status !== "closed") return;
  started.delete(state.environmentId);
  // Only an expired ticket is worth retrying; a replaced or refused host must step aside.
  if (state.reason !== "unauthorized" || !desired.has(state.environmentId)) return;
  window.setTimeout(() => void syncHosts(knownEnvironmentIds), UNAUTHORIZED_RETRY_MS);
};

/** Keeps this app's browser pane connected to every remote environment it can preview. */
export function usePreviewBrowserHost(environmentIds: readonly EnvironmentId[]): void {
  useEffect(() => {
    const preview = isElectron ? window.desktopBridge?.preview : undefined;
    if (!preview?.startBrowserHost) return;
    const unsubscribe = preview.onBrowserHostState?.(applyHostState);
    void syncHosts(environmentIds);
    return () => {
      unsubscribe?.();
    };
  }, [environmentIds]);
}
