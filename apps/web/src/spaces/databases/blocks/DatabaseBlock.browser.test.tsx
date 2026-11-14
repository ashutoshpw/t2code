import "~/index.css";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../../test/render";
import { FakeDatabase } from "../test/fakeDatabase";
import { DatabaseHarness, fakeController, testHost } from "../test/harness";
import { readyWhen } from "../test/readyWhen";

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
    await expect.element(screen.getByText(/The original database was deleted/)).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Remove block" })).toBeVisible();
  });

  describe("title menu", () => {
    const mount = async (
      props: { hideTitle?: boolean; editable?: boolean } = {},
      router: string | false = false,
    ) => {
      const { controller } = fakeController();
      const onSetTitleHidden = vi.fn();
      const mounted = {
        onSetTitleHidden,
        screen: await render(
          <DatabaseHarness
            host={testHost(controller)}
            initialViewIds={["view-table"]}
            onSetTitleHidden={onSetTitleHidden}
            {...props}
          />,
          // The block itself needs no router; "View database" does.
          { router },
        ),
      };
      return readyWhen(mounted, ({ screen }) =>
        expect.element(screen.getByRole("tab", { name: "Table" })).toBeVisible(),
      );
    };
    const open = async (screen: Awaited<ReturnType<typeof mount>>["screen"]) => {
      await userEvent.click(screen.getByRole("textbox", { name: "Database title" }));
      await userEvent.click(screen.getByRole("button", { name: "Database options" }));
    };
    const item = (name: string) => page.getByRole("menuitem", { name });

    it("lists the writer's actions and hides the title through the block", async () => {
      setup();
      const { screen, onSetTitleHidden } = await mount();
      await using _screen = screen;
      await open(screen);
      for (const name of ["View database", "Edit title", "Edit icon", "Edit layout", "Hide title"])
        await expect.element(item(name)).toBeVisible();
      await userEvent.click(item("Hide title"));
      expect(onSetTitleHidden).toHaveBeenCalledWith(true);
      await expect
        .element(screen.getByRole("textbox", { name: "Database title" }))
        .not.toBeInTheDocument();
    });

    it("picks and removes the icon", async () => {
      const fake = setup();
      const { screen } = await mount();
      await using _screen = screen;
      await open(screen);
      await userEvent.click(item("Edit icon"));
      await userEvent.click(page.getByRole("button", { name: /^Use / }).first());
      await vi.waitFor(() => expect(fake.callsOf("update")).toHaveLength(1));
      const icon = fake.callsOf("update")[0]!.input.icon;
      expect(typeof icon).toBe("string");
      await userEvent.click(screen.getByRole("button", { name: "Change database icon" }));
      await userEvent.click(page.getByRole("button", { name: "Remove" }));
      await vi.waitFor(() => expect(fake.callsOf("update")[1]?.input.icon).toBeNull());
    });

    it("offers only View database without edit permissions", async () => {
      setup({ permissions: { rename: false, views: false } });
      const { screen } = await mount({ editable: false });
      await using _screen = screen;
      await userEvent.click(screen.getByRole("button", { name: "Database options" }));
      await expect.element(item("View database")).toBeVisible();
      await expect.element(page.getByRole("menuitem")).toHaveLength(1);
    });

    it("opens the database as a full page", async () => {
      setup();
      const { screen } = await mount({}, "/");
      await using _screen = screen;
      await open(screen);
      await userEvent.click(item("View database"));
      await vi.waitFor(() =>
        expect(screen.router?.state.location.pathname).toBe(
          "/spaces/environment-1/space-1/database/database-1",
        ),
      );
    });
  });
});
