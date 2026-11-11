import "~/index.css";

import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { SpaceDataSource } from "@t2code/contracts/spaces";

import { render } from "../../../../test/render";
import { layoutSectionProps } from "./gallerySectionHarness";
import { mountRows } from "../list/listHarness";
import { FakeDatabase } from "../test/fakeDatabase";
import { readyWhen } from "../test/readyWhen";

import { fixtureView } from "../test/fixtures";
import { GalleryLayoutSection } from "./GalleryLayoutSection";

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

const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const COVER = { id: "cover", name: "Cover", type: "files", config: {}, position: 7 };

async function mount(
  options: ConstructorParameters<typeof FakeDatabase>[0] = { rows: 6 },
  layout: Record<string, unknown> = {},
  patch: Record<string, unknown> = {},
) {
  const view = {
    ...fixtureView("view-gallery", "gallery", "Gallery", 0, layout),
    ...patch,
  } as never;
  const fake = new FakeDatabase({ quietRowWrites: true, ...options, views: [view] });
  fake.dataSource = {
    ...fake.dataSource,
    properties: { ...fake.dataSource.properties, cover: COVER },
  } as never;
  fake.rows = fake.rows.map(
    (row) =>
      ({
        ...row,
        cells: {
          ...row.cells,
          ...(row.page.id === "row-1" ? { cover: [{ name: "one.png", url: PIXEL }] } : {}),
        },
      }) as never,
  );
  state.fake = fake;
  await page.viewport(1400, 900);
  const mounted = await readyWhen(
    await mountRows(view, options.permissions?.rows !== false),
    (rows) => vi.waitFor(() => expect(rows.scroller()).toBeTruthy()),
  );
  return { fake, ...mounted };
}
const cardIds = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>("[data-card-id]")].map((card) => card.dataset.cardId!);
const inList = (root: HTMLElement) => page.elementLocator(root);
const firstRowCards = (root: HTMLElement) =>
  root.querySelector('[data-item-index="0"]')!.querySelectorAll("[role=listitem]").length;

describe("cards", () => {
  it("shows a card per row with the title and visible properties and opens it", async () => {
    const { screen, host, scroller } = await mount();
    await using _screen = screen;
    await vi.waitFor(() => expect(cardIds(scroller())).toHaveLength(6));
    const first = scroller().querySelector<HTMLElement>('[data-card-id="row-1"]')!;
    expect(first.textContent).toContain("Task 1");
    expect(first.textContent).toContain("Not started");
    await userEvent.click(screen.getByRole("button", { name: /^Task 4\b/ }));
    expect(host.openPage).toHaveBeenCalledWith(expect.objectContaining({ pageId: "row-4" }));
  });

  it("draws no cover without a card preview", async () => {
    const { screen, scroller } = await mount({ rows: 2 });
    await using _screen = screen;
    await vi.waitFor(() => expect(cardIds(scroller())).toHaveLength(2));
    expect(scroller().querySelector("[data-card-cover]")).toBeNull();
  });
});

describe("cover", () => {
  const preview = { cardPreview: { kind: "property", propertyId: "cover" } };

  it("loads the files property image lazily in a fixed-height box, even when the property is hidden", async () => {
    const { fake, screen, scroller } = await mount({ rows: 3 }, preview);
    await using _screen = screen;
    await vi.waitFor(() => expect(scroller().querySelector("img")).not.toBeNull());
    const image = scroller().querySelector("img")!;
    expect(image.getAttribute("src")).toBe(PIXEL);
    expect(image.getAttribute("loading")).toBe("lazy");
    expect(image.className).toContain("object-cover");
    const boxes = [...scroller().querySelectorAll<HTMLElement>("[data-card-cover]")];
    expect(boxes).toHaveLength(3);
    expect(boxes.every((box) => box.style.height === "160px")).toBe(true);
    expect(JSON.stringify(fake.callsOf("query")[0]!.input)).toContain('"cover"');
  });

  it("fits the image instead of cropping it", async () => {
    const { screen, scroller } = await mount({ rows: 1 }, { ...preview, fitImage: true });
    await using _screen = screen;
    await vi.waitFor(() => expect(scroller().querySelector("img")).not.toBeNull());
    expect(scroller().querySelector("img")!.className).toContain("object-contain");
  });
});

describe("card size", () => {
  it("fits more small cards than large ones in a row and sizes the cover to match", async () => {
    const small = await mount(
      { rows: 12 },
      { cardSize: "small", cardPreview: { kind: "property", propertyId: "cover" } },
    );
    let smallColumns = 0;
    let smallCover = "";
    {
      await using _screen = small.screen;
      await vi.waitFor(() => expect(cardIds(small.scroller()).length).toBeGreaterThan(4));
      smallColumns = firstRowCards(small.scroller());
      smallCover = small.scroller().querySelector<HTMLElement>("[data-card-cover]")!.style.height;
    }
    const large = await mount(
      { rows: 12 },
      { cardSize: "large", cardPreview: { kind: "property", propertyId: "cover" } },
    );
    await using _screen = large.screen;
    await vi.waitFor(() => expect(cardIds(large.scroller()).length).toBeGreaterThan(2));
    expect(smallColumns).toBeGreaterThan(firstRowCards(large.scroller()));
    expect(smallCover).toBe("100px");
    expect(large.scroller().querySelector<HTMLElement>("[data-card-cover]")!.style.height).toBe(
      "200px",
    );
  });
});

describe("add card", () => {
  it("adds a row from the new card and opens it", async () => {
    const { fake, screen, host, scroller } = await mount({ rows: 2 });
    await using _screen = screen;
    await userEvent.click(inList(scroller()).getByRole("button", { name: "New" }));
    await vi.waitFor(() => expect(fake.callsOf("createRows")).toHaveLength(1));
    await vi.waitFor(() =>
      expect(host.openPage).toHaveBeenCalledWith(expect.objectContaining({ pageId: "row-new-1" })),
    );
  });

  it("adds into a group with the group's value", async () => {
    const { fake, screen, scroller } = await mount(
      { rows: 3 },
      {},
      { group: { property: "status" } },
    );
    await using _screen = screen;
    const adds = inList(scroller()).getByRole("button", { name: "New" });
    await vi.waitFor(() => expect(adds.all().length).toBe(4));
    await userEvent.click(adds.nth(1));
    await vi.waitFor(() => expect(fake.callsOf("createRows")).toHaveLength(1));
    expect(fake.callsOf("createRows")[0]!.input.rows).toEqual([{ cells: { status: "doing" } }]);
  });
});

describe("windowing", () => {
  it("mounts only a window of 500 cards and loads the next page near the end", async () => {
    const { fake, screen, scroller } = await mount({ rows: 500 });
    await using _screen = screen;
    await vi.waitFor(() => expect(cardIds(scroller()).length).toBeGreaterThan(4));
    expect(cardIds(scroller()).length).toBeLessThan(80);
    scroller().scrollTop = scroller().scrollHeight;
    await vi.waitFor(() => expect(fake.callsOf("query").length).toBeGreaterThan(1));
    expect(fake.callsOf("query").at(-1)!.input).toMatchObject({ cursor: "100" });
  });
});

describe("read-only", () => {
  it("opens cards but offers no new card or delete", async () => {
    const { screen, host, scroller } = await mount({
      rows: 3,
      permissions: { rows: false, cells: false },
    });
    await using _screen = screen;
    await userEvent.click(screen.getByRole("button", { name: /^Task 1\b/ }));
    expect(host.openPage).toHaveBeenCalled();
    await expect
      .element(inList(scroller()).getByRole("button", { name: "New" }))
      .not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Row actions for Task 2" }));
    await expect.element(screen.getByRole("menuitem", { name: "Delete" })).not.toBeInTheDocument();
  });
});

describe("layout section", () => {
  function Section({
    onEdit,
    dataSource,
  }: {
    readonly onEdit: (layout: unknown) => void;
    readonly dataSource: SpaceDataSource;
  }) {
    const [view, setView] = useState(fixtureView("v", "gallery", "Gallery", 0));
    return (
      <GalleryLayoutSection
        {...layoutSectionProps(view, dataSource, (next) => {
          setView(next);
          onEdit(next.layout);
        })}
      />
    );
  }

  it("changes the size, the cover property and fit", async () => {
    const onEdit = vi.fn();
    const dataSource = {
      properties: {
        cover: COVER,
        title: { id: "title", name: "Name", type: "title", config: {}, position: 0 },
      },
    } as unknown as SpaceDataSource;
    // The section is a plain form with no router link in it.
    await using screen = await render(<Section onEdit={onEdit} dataSource={dataSource} />, {
      router: false,
    });
    await userEvent.click(screen.getByRole("combobox", { name: "Card size" }));
    await userEvent.click(page.getByRole("option", { name: "Large" }));
    await vi.waitFor(() => expect(onEdit).toHaveBeenLastCalledWith({ cardSize: "large" }));
    await userEvent.click(screen.getByRole("combobox", { name: "Card preview" }));
    await userEvent.click(page.getByRole("option", { name: "Cover" }));
    await vi.waitFor(() =>
      expect(onEdit).toHaveBeenLastCalledWith({
        cardSize: "large",
        cardPreview: { kind: "property", propertyId: "cover" },
      }),
    );
    await userEvent.click(screen.getByRole("switch", { name: "Fit image" }));
    await vi.waitFor(() =>
      expect(onEdit).toHaveBeenLastCalledWith({
        cardSize: "large",
        cardPreview: { kind: "property", propertyId: "cover" },
        fitImage: true,
      }),
    );
  });
});
