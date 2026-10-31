import { EnvironmentId } from "@t2code/contracts";
import { SpaceId, SpacePageId, type SpacePageSummary } from "@t2code/contracts/spaces";
import { Atom } from "effect/reactivity";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";

const mocks = vi.hoisted(() => ({
  query: {} as Record<string, unknown>,
  documentMounted: vi.fn(),
}));

vi.mock(import("../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => mocks.query) as never,
}));

vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironment: (() => ({
    serverConfig: { environment: { capabilities: { spaces: { version: 2 } } } },
  })) as never,
}));

vi.mock(import("../state/spaces"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useSpacesAvailability: () => "writable",
    spacesEnvironment: {
      ...actual.spacesEnvironment,
      location: () => "location-query",
      recordRecent: { permissionAtom: () => Atom.make(false) },
    } as never,
  };
});

vi.mock(import("./SpaceDocumentSurface"), () => ({
  SpaceDocumentSurface: () => {
    useState(() => mocks.documentMounted());
    return <div data-testid="document" />;
  },
}));
vi.mock(import("./SpacePinButton"), () => ({ SpacePinButton: () => null }));
vi.mock(import("./SpacePageShareStatus"), () => ({ SpacePageShareStatus: () => null }));
vi.mock(import("./SpaceLibraryControls"), () => ({
  PageTitleField: () => <h1>Page title</h1>,
  PageIconField: () => null,
}));
vi.mock(import("./SpaceRecoveryControls"), () => ({ default: () => null }));
vi.mock(import("./SpaceStructureControls"), () => ({ default: () => <></> }));

import SpacePageSurface from "./SpacePageSurface";

const environmentId = EnvironmentId.make("env");
const target = {
  environmentId,
  spaceId: SpaceId.make("space"),
  pageId: SpacePageId.make("page"),
};
const page: SpacePageSummary = {
  id: target.pageId,
  spaceId: target.spaceId,
  title: "Page",
  revision: 1,
  rootOrder: "1",
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:00:00.000Z",
};
const space = {
  id: target.spaceId,
  title: "Space",
  revision: 1,
  rootOrderRevision: 1,
  isDefault: true,
  createdAt: page.createdAt,
  updatedAt: page.updatedAt,
};

function setup() {
  mocks.documentMounted.mockReset();
  mocks.query = { isSuccess: false, isPending: true, error: null, data: undefined };
}

describe("SpacePageSurface", () => {
  it("keeps the same document mounted while the page location loads", async () => {
    setup();
    await using screen = await render(<SpacePageSurface target={target} fullPage />);
    await expect.element(screen.getByRole("status", { name: "Loading page" })).toBeInTheDocument();
    const loading = screen.getByTestId("document").element();

    mocks.query = {
      isSuccess: true,
      isPending: false,
      error: null,
      data: { current: () => ({ page, space, ancestors: [] }) },
    };
    await screen.rerender(<SpacePageSurface target={target} fullPage />);

    await expect
      .element(screen.getByRole("status", { name: "Loading page" }))
      .not.toBeInTheDocument();
    expect(screen.getByTestId("document").element()).toBe(loading);
    expect(mocks.documentMounted).toHaveBeenCalledTimes(1);
  });
});
