import { EnvironmentId } from "@t2code/contracts";
import type { SpaceRootReorder } from "@t2code/client-runtime/spaces";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";

const mocks = vi.hoisted(() => ({
  owner: {} as unknown,
}));

vi.mock(import("../state/spaces"), async (original) => ({
  ...(await original()),
  useSpacesAvailability: () => "writable",
}));

vi.mock(import("./sessionRuntime"), () => ({
  spaceRootReorder: (() => mocks.owner) as never,
}));

import { CreateStatus } from "./SpaceCreateControls";

function setup(snapshot: { busy: boolean; pending: boolean }) {
  const state = {
    busy: snapshot.busy,
    hydrated: true,
    error: null,
    journal: { pending: snapshot.pending ? {} : null },
  };
  mocks.owner = {
    subscribe: () => () => {},
    getSnapshot: () => state,
    hydrate: async () => {},
  } as unknown as SpaceRootReorder;
}

describe("CreateStatus", () => {
  it("stays quiet while the operation that owns the pending entry is still running", async () => {
    setup({ busy: true, pending: true });
    await using screen = await render(<CreateStatus environmentId={EnvironmentId.make("env")} />);
    await expect
      .element(screen.getByText("A library change is waiting for confirmation."))
      .not.toBeInTheDocument();
  });

  it("offers to finish a leftover pending change once nothing is running", async () => {
    setup({ busy: false, pending: true });
    await using screen = await render(<CreateStatus environmentId={EnvironmentId.make("env")} />);
    await expect
      .element(screen.getByText("A library change is waiting for confirmation."))
      .toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Finish it" })).toBeInTheDocument();
  });
});
