import "~/index.css";

import { SpaceId } from "@t2code/contracts/spaces";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../../test/render";
import { FIXTURE_IDS } from "../test/fixtures";
import { FakeDatabase } from "../test/fakeDatabase";
import { readyWhen } from "../test/readyWhen";
import { TEST_ENVIRONMENT } from "../test/harness";

const state = vi.hoisted(() => ({ fake: null as unknown }));

vi.mock(import("../data/ports"), async () => {
  const { fakePortsModule } = await import("../test/fakeDatabase");
  return fakePortsModule(() => state.fake as never) as never;
});
vi.mock(import("../../../state/environments"), async (original) => {
  const { environmentWith } = await import("../test/environment");
  return { ...(await original()), useEnvironment: (() => environmentWith(true)) as never };
});
vi.mock(import("../../../state/spaces"), async (original) => {
  const actual = await original();
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const { locationFor } = await import("./rowLocations");
  const atoms = new Map<string, unknown>();
  return {
    ...actual,
    useSpacesAvailability: () => "writable",
    spacesEnvironment: {
      ...actual.spacesEnvironment,
      location: ({ input }: { input: { pageId: string } }) => {
        let atom = atoms.get(input.pageId);
        if (atom === undefined) {
          const data = locationFor(input.pageId);
          atom = Atom.make(AsyncResult.success({ current: () => data }));
          atoms.set(input.pageId, atom);
        }
        return atom;
      },
      recordRecent: { permissionAtom: () => Atom.make(false) },
    } as never,
  };
});
vi.mock(import("../../SpaceDocumentSurface"), async () => {
  const { DocumentStub } = await import("./rowPageHarness");
  return { SpaceDocumentSurface: DocumentStub };
});
vi.mock(import("../../SpacePinButton"), () => ({ SpacePinButton: () => null }));
vi.mock(import("../../SpacePageShareStatus"), () => ({ SpacePageShareStatus: () => null }));
vi.mock(import("../../SpaceLibraryControls"), async () => {
  const { TitleStub } = await import("./rowPageHarness");
  return { PageTitleField: TitleStub, PageIconField: () => null };
});
vi.mock(import("../../SpaceStructureControls"), () => ({ default: () => <></> }));
vi.mock(import("../../SpaceRecoveryControls"), async () => {
  const { recoveryStub } = await import("./rowPageHarness");
  return { default: recoveryStub(() => state.fake as never) };
});

import SpacePageSurface from "../../SpacePageSurface";
import { HOST_PAGE } from "./rowLocations";

async function mount() {
  const fake = new FakeDatabase({ rows: 5, quietRowWrites: true });
  state.fake = fake;
  await page.viewport(1800, 900);
  const screen = await render(
    <SpacePageSurface
      target={{
        environmentId: TEST_ENVIRONMENT,
        spaceId: SpaceId.make(FIXTURE_IDS.space),
        pageId: HOST_PAGE,
      }}
      fullPage
    />,
  );
  const cell = (rowId: string, column: string) =>
    screen.container.querySelector<HTMLElement>(`[data-row="${rowId}"][data-col="${column}"]`);
  const openRow = async (rowId: string) =>
    userEvent.click(
      page.elementLocator(cell(rowId, "title")!).getByRole("button", { name: "Open row" }),
    );
  return readyWhen({ fake, screen, cell, openRow }, () =>
    vi.waitFor(() => expect(cell("row-1", "title")).not.toBeNull()),
  );
}

describe("row peek", () => {
  it("opens a row beside its table, swaps it for another and closes with Escape", async () => {
    const { screen, openRow, cell } = await mount();
    await using _screen = screen;
    await expect
      .element(page.getByRole("complementary", { name: "Row peek" }))
      .not.toBeInTheDocument();
    await openRow("row-1");
    const peek = page.getByRole("complementary", { name: "Row peek" });
    await expect.element(peek).toBeVisible();
    await expect.element(peek.getByRole("textbox", { name: "Title" })).toHaveValue("Task 1");
    // The table stays usable and a second row replaces the first.
    await openRow("row-2");
    await expect.element(peek.getByRole("textbox", { name: "Title" })).toHaveValue("Task 2");
    await userEvent.click(peek.getByRole("textbox", { name: "Body" }));
    await userEvent.keyboard("{Escape}");
    await expect.element(peek).not.toBeInTheDocument();
    expect(document.activeElement).toBe(
      cell("row-2", "title")?.querySelector('[aria-label="Open row"]') ?? document.body,
    );
  });

  it("shows the properties above the body and keeps the body while a property changes", async () => {
    const { fake, screen, openRow } = await mount();
    await using _screen = screen;
    await openRow("row-1");
    const peek = page.getByRole("complementary", { name: "Row peek" });
    const properties = peek.getByRole("region", { name: "Row properties" });
    await expect.element(properties).toBeVisible();
    const body = peek.getByRole("textbox", { name: "Body" });
    expect(
      properties.element().compareDocumentPosition(body.element()) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await userEvent.fill(body, "Notes in the body");
    await userEvent.click(properties.getByRole("button", { name: "Notes", exact: true }));
    await userEvent.fill(properties.getByRole("textbox", { name: "Notes" }), "Header text");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(fake.callsOf("updateRows")).toHaveLength(1));
    await expect.element(body).toHaveValue("Notes in the body");
    // The row page has no place in the page tree.
    await peek.getByRole("button", { name: "More actions" }).click();
    await expect.element(page.getByRole("menuitem", { name: "Move to…" })).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("menuitem", { name: "Add sub-page" }))
      .not.toBeInTheDocument();
    await expect.element(page.getByRole("menuitem", { name: "Move to trash" })).toBeVisible();
  });

  it("ends the breadcrumb with the host page and the row", async () => {
    const { screen, openRow } = await mount();
    await using _screen = screen;
    await openRow("row-1");
    const crumbs = page.getByRole("complementary", { name: "Row peek" }).getByRole("navigation", {
      name: "Page location",
    });
    await vi.waitFor(() =>
      expect(crumbs.element().textContent).toMatch(/Space.*Host page.*Task 1/),
    );
  });

  it("refreshes the table when the row is trashed and restored from its page", async () => {
    const { screen, openRow, cell } = await mount();
    await using _screen = screen;
    await openRow("row-1");
    const peek = page.getByRole("complementary", { name: "Row peek" });
    await peek.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Move to trash" }).click();
    await vi.waitFor(() => expect(cell("row-1", "title")).toBeNull());
    await peek.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "View trash" }).click();
    await vi.waitFor(() => expect(cell("row-1", "title")).not.toBeNull());
  });

  it("opens the row as a full page from the peek", async () => {
    const { screen, openRow } = await mount();
    await using _screen = screen;
    await openRow("row-3");
    const link = page.getByRole("link", { name: "Open as full page" });
    await expect.element(link).toHaveAttribute("href", expect.stringContaining("row-3"));
  });
});
