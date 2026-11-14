import "~/index.css";

import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { mountTable } from "../table/tableHarness";
import { FakeDatabase } from "../test/fakeDatabase";
import { fixtureDataSource } from "../test/fixtures";

const state = vi.hoisted(() => ({ fake: null as unknown }));

vi.mock(import("../data/ports"), async () => {
  const { fakePortsModule } = await import("../test/fakeDatabase");
  return fakePortsModule(() => state.fake as never) as never;
});
vi.mock(import("../../../state/environments"), async (original) => {
  const { environmentWith } = await import("../test/environment");
  return { ...(await original()), useEnvironment: (() => environmentWith(true)) as never };
});
vi.mock(import("../../../state/spaces"), async (original) => ({
  ...(await original()),
  useSpacesAvailability: () => "writable",
}));

async function mount(options: { defaultTemplate?: boolean } = {}) {
  const base = fixtureDataSource();
  const fake = new FakeDatabase({
    rows: 2,
    quietRowWrites: true,
    dataSource: {
      ...base,
      templates: [
        { pageId: "tpl-bug", title: "Bug report" },
        { pageId: "tpl-idea", title: "Idea" },
      ],
      ...(options.defaultTemplate === false ? {} : { defaultTemplateId: "tpl-bug" }),
    } as never,
  });
  state.fake = fake;
  const table = await mountTable(fake);
  await vi.waitFor(() => expect(table.cell("row-1", "title")).not.toBeNull());
  return { fake, ...table };
}
const caret = () => page.getByRole("button", { name: "New row options" });
/** Opens "Manage templates" and the submenu of one template with the keyboard, as hover paths are flaky. */
async function openTemplateMenu(index: number) {
  await userEvent.click(caret());
  await userEvent.hover(page.getByRole("menuitem", { name: "Manage templates" }));
  await userEvent.keyboard("{ArrowRight}");
  for (let step = 0; step < index; step += 1) await userEvent.keyboard("{ArrowDown}");
  await userEvent.keyboard("{ArrowRight}");
}
const created = (fake: FakeDatabase) => {
  const rows = fake.callsOf("createRows").at(-1)?.input.rows as
    | Record<string, unknown>[]
    | undefined;
  return rows?.[0];
};

describe("new row menu", () => {
  it("creates from the default template, a chosen one, or a blank page", async () => {
    const { fake, screen, host } = await mount();
    await using _screen = screen;
    await userEvent.click(screen.getByRole("button", { name: "New", exact: true }).first());
    await vi.waitFor(() => expect(created(fake)?.templateId).toBe("tpl-bug"));
    await vi.waitFor(() => expect(host.openPage).toHaveBeenCalledTimes(1));

    await userEvent.click(caret());
    await userEvent.click(page.getByRole("menuitem", { name: "Idea" }));
    await vi.waitFor(() => expect(created(fake)?.templateId).toBe("tpl-idea"));

    await userEvent.click(caret());
    await userEvent.click(page.getByRole("menuitem", { name: "Empty page" }));
    await vi.waitFor(() => expect(fake.callsOf("createRows")).toHaveLength(3));
    expect(created(fake)).not.toHaveProperty("templateId");
  });

  it("creates a new template and opens it", async () => {
    const { fake, screen, host } = await mount();
    await using _screen = screen;
    await userEvent.click(caret());
    await userEvent.click(page.getByRole("menuitem", { name: "New template" }));
    await vi.waitFor(() => expect(created(fake)?.asTemplate).toBe(true));
    await vi.waitFor(() => expect(host.openPage).toHaveBeenCalledTimes(1));
    expect(fake.dataSource.templates).toHaveLength(3);
    await userEvent.click(caret());
    await expect.element(page.getByRole("menuitem", { name: "Untitled" })).toBeVisible();
  });

  it("sets and removes the default and deletes a template", async () => {
    const { fake, screen } = await mount({ defaultTemplate: false });
    await using _screen = screen;
    await openTemplateMenu(1);
    await userEvent.click(page.getByRole("menuitem", { name: "Set as default" }));
    await vi.waitFor(() =>
      expect(fake.callsOf("updateDataSource").at(-1)?.input.defaultTemplateId).toBe("tpl-idea"),
    );
    // New now sends the default.
    await userEvent.click(screen.getByRole("button", { name: "New", exact: true }).first());
    await vi.waitFor(() => expect(created(fake)?.templateId).toBe("tpl-idea"));

    await openTemplateMenu(1);
    await userEvent.click(page.getByRole("menuitem", { name: "Remove as default" }));
    await vi.waitFor(() =>
      expect(fake.callsOf("updateDataSource").at(-1)?.input.defaultTemplateId).toBeNull(),
    );

    await openTemplateMenu(0);
    await userEvent.click(page.getByRole("menuitem", { name: "Delete" }));
    await vi.waitFor(() => expect(fake.callsOf("trashRow")).toHaveLength(1));
    expect(fake.callsOf("trashRow")[0]!.input).toEqual({ pageId: "tpl-bug" });
  });
});
