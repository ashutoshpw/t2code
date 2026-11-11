import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../../test/render";
import { FakeDatabase } from "../test/fakeDatabase";
import { DatabaseHarness, fakeController, testHost } from "../test/harness";

const state = vi.hoisted(() => ({
  fake: null as unknown,
  databases: true,
}));

vi.mock(import("../data/ports"), async () => {
  const { fakePortsModule: build } = await import("../test/fakeDatabase");
  return build(() => state.fake as never) as never;
});
vi.mock(import("../../../state/environments"), async (original) => {
  const { environmentWith } = await import("../test/environment");
  return {
    ...(await original()),
    useEnvironment: (() => environmentWith(state.databases)) as never,
  };
});
vi.mock(import("../../../state/spaces"), async (original) => ({
  ...(await original()),
  useSpacesAvailability: () => "writable",
}));

function setup(options: ConstructorParameters<typeof FakeDatabase>[0] = {}, databases = true) {
  const fake = new FakeDatabase(options);
  state.fake = fake;
  state.databases = databases;
  return fake;
}

describe("DatabaseBlock", () => {
  it("shows a note on a server without databases and queries nothing", async () => {
    const fake = setup({}, false);
    const { controller } = fakeController();
    await using screen = await render(
      <DatabaseHarness host={testHost(controller)} initialViewIds={["view-table"]} />,
      { router: false },
    );
    await expect.element(screen.getByText("Databases need a newer T2 Code server.")).toBeVisible();
    expect(fake.calls).toEqual([]);
  });

  it("waits for the page to save a dead database, then loads it", async () => {
    const fake = setup({ live: false });
    const session = fakeController({ dirty: true, pending: false });
    await using screen = await render(
      <DatabaseHarness host={testHost(session.controller)} initialViewIds={["view-table"]} />,
      { router: false },
    );
    await expect.element(screen.getByText("Saving database...")).toBeVisible();
    // The server adopts the database with the saved block.
    fake.database = { ...fake.database, live: true };
    session.set({ dirty: false, pending: false });
    await expect.element(screen.getByRole("tab", { name: "Table" })).toBeVisible();
  });

  it("offers to remove the block when the database is gone for good", async () => {
    setup({ live: false });
    const { controller } = fakeController();
    await using screen = await render(
      <DatabaseHarness host={testHost(controller)} initialViewIds={["view-table"]} />,
      { router: false },
    );
    await expect.element(screen.getByText("This database is no longer available.")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Remove block" })).toBeVisible();
  });
});
