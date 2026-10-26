import { BearerConnectionTarget, type PreparedConnection } from "@t2code/client-runtime/connection";
import { EnvironmentId } from "@t2code/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  prepared: null as PreparedConnection | null,
  supportsServerBrowser: true,
  previewSupportedInRuntime: true,
  primaryEnvironmentId: null as EnvironmentId | null,
}));

vi.mock(import("~/env"), async (original) => ({ ...(await original()), isElectron: true }));

vi.mock(import("~/previewStateStore"), async (original) => ({
  ...(await original()),
  isPreviewSupportedInRuntime: () => mocks.previewSupportedInRuntime,
}));

vi.mock(import("~/state/primaryEnvironment"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  return {
    ...(await original()),
    // Goes through the real registry, but answers with the test's primary.
    primaryEnvironmentIdAtom: Atom.make(() => mocks.primaryEnvironmentId),
  };
});

vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readPreparedConnection: () => mocks.prepared,
}));

vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  readEnvironmentSupportsServerBrowser: () => mocks.supportsServerBrowser,
  useEnvironmentSupportsServerBrowser: () => mocks.supportsServerBrowser,
}));

vi.mock(import("~/state/previewStream"), () => ({
  readPreviewStreamAccess: () => Promise.resolve(null),
}));

import { usePreviewHostStore } from "./previewHost";
import {
  previewRuntimeFor,
  rendersServerTabNatively,
  serverTabTransportId,
} from "./previewRuntime";

const remote = EnvironmentId.make("env-remote");
const primary = EnvironmentId.make("env-primary");

const connection = (connectionId: string): PreparedConnection => ({
  environmentId: primary,
  label: "test",
  httpBaseUrl: "http://t2.test",
  socketUrl: "ws://t2.test",
  httpAuthorization: null,
  target: new BearerConnectionTarget({
    environmentId: primary,
    label: "test",
    connectionId,
  }),
});
const remoteTarget = connection("conn-1");
const bundledTarget = connection("local:backend");
const serverTab = { runtime: "server" } as const;

const host = (
  environmentId: EnvironmentId,
  status: "connecting" | "connected" | "closed",
): void => {
  usePreviewHostStore.getState().apply({ environmentId, status });
};

function setup(): void {
  usePreviewHostStore.setState({ statusByEnvironmentId: {} });
  mocks.prepared = remoteTarget;
  mocks.supportsServerBrowser = true;
  mocks.previewSupportedInRuntime = true;
  mocks.primaryEnvironmentId = primary;
}

describe("previewRuntime", () => {
  beforeEach(setup);

  it("renders a remote server tab here only while this app hosts that environment", () => {
    expect(rendersServerTabNatively(remote, primary, serverTab)).toBe(false);
    host(remote, "connected");
    expect(rendersServerTabNatively(remote, primary, serverTab)).toBe(true);
    host(remote, "closed");
    expect(rendersServerTabNatively(remote, primary, serverTab)).toBe(false);
  });

  it("keeps rendering the bundled server's tabs regardless of hosting", () => {
    expect(rendersServerTabNatively(primary, primary, serverTab)).toBe(true);
    expect(rendersServerTabNatively(remote, primary, { runtime: "desktop" })).toBe(false);
  });

  it("addresses a tab to the server that drives it", () => {
    expect(serverTabTransportId(remote)).toBe(remote);
    mocks.prepared = bundledTarget;
    expect(serverTabTransportId(primary)).toBe("fd");
    mocks.prepared = null;
    expect(serverTabTransportId(remote)).toBe(remote);
  });

  it("asks a hosted environment for a server tab", () => {
    expect(previewRuntimeFor(remote)).toBeUndefined();
    host(remote, "connected");
    expect(previewRuntimeFor(remote)).toBe("server");
  });
});
