import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render, stubGlobal } from "../../../../test/render";
import SharedDatabase, { type SharedDatabaseProps } from "./SharedDatabase";
import { description, row, shareFetch, view, window as windowOf } from "./sharedDatabase.testkit";

const props: SharedDatabaseProps = {
  blockId: "blk1",
  pageId: "page1",
  credential: "cred.sig",
  layout: "page",
  rowHref: (blockId, viewId, rowId) => `/?block=${blockId}&view=${viewId}&row=${rowId}`,
  openRow: () => {},
};

const todo = { kind: "option", optionId: "o1" };
const done = { kind: "option", optionId: "o2" };
const options = {
  st: [
    { id: "o1", name: "Todo", color: "red" },
    { id: "o2", name: "Done", color: "green" },
  ],
};

describe("shared views", () => {
  it("sizes table columns, colors option chips from the window and shows relation titles as text", async () => {
    const share = shareFetch({
      database: () =>
        description([
          view("v1", "table", {}, [
            { propertyId: "n", width: 140 },
            { propertyId: "st" },
            { propertyId: "rel" },
          ]),
        ]),
      query: () =>
        windowOf([row("r1", "Ship it", { n: 7, st: "o1", rel: ["p9"] })], {
          options,
          relatedPages: { p9: { title: "Linked page", dataSourceId: "ds2" } },
        }),
    });
    using _fetch = stubGlobal("fetch", share.fetch);
    await using screen = await render(<SharedDatabase {...props} />, { router: "/" });

    await expect.element(screen.getByRole("columnheader", { name: "Score" })).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "Score" }).element().style.minWidth).toBe(
      "140px",
    );
    await expect.element(screen.getByText("Todo")).toBeVisible();
    await expect.element(screen.getByText("Linked page")).toBeVisible();
    expect(screen.getByText("Linked page").element().closest("a")).toBeNull();
    // A full-page database leaves its title to the page.
    expect(screen.getByRole("heading", { name: "Tasks" }).elements()).toHaveLength(0);
  });

  it("continues one table bucket by its key and cursor", async () => {
    const share = shareFetch({
      database: () => description([view("v1", "table", { group: { property: "st" } })]),
      query: (call) =>
        call.params.get("group") === null
          ? windowOf([], {
              options,
              groups: [
                { key: todo, count: 12, rows: [row("r1", "First")], nextCursor: "g1" },
                { key: done, count: 1, rows: [row("r9", "Last")], nextCursor: null },
              ],
            })
          : windowOf([row("r2", "Second")], { options }),
    });
    using _fetch = stubGlobal("fetch", share.fetch);
    await using screen = await render(<SharedDatabase {...props} />, { router: "/" });

    await expect.element(screen.getByText("12")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Show more" }));
    await expect.element(screen.getByRole("link", { name: "Second" })).toBeVisible();
    const [, more] = share.queries();
    expect(JSON.parse(more!.params.get("group")!)).toEqual(todo);
    expect(more!.params.get("cursor")).toBe("g1");
    expect(screen.getByRole("link", { name: "Last" }).elements()).toHaveLength(1);
  });

  it("lays board columns out in the saved group order", async () => {
    const share = shareFetch({
      database: () =>
        description([view("v1", "board", { group: { property: "st", order: [done, todo] } })]),
      query: () =>
        windowOf([], {
          options,
          groups: [
            { key: todo, count: 1, rows: [row("r1", "Open task")], nextCursor: null },
            { key: done, count: 1, rows: [row("r2", "Closed task")], nextCursor: null },
          ],
        }),
    });
    using _fetch = stubGlobal("fetch", share.fetch);
    await using screen = await render(<SharedDatabase {...props} />, { router: "/" });

    await expect.element(screen.getByRole("link", { name: "Open task" })).toBeVisible();
    const headings = [...screen.container.querySelectorAll("section h3")].map((h) => h.textContent);
    expect(headings).toEqual(["Done1", "Todo1"]);
  });

  it("draws gallery covers through the row form of the asset route and hides a broken one", async () => {
    const share = shareFetch({
      database: () =>
        description([view("v1", "gallery", { layout: { cardPreview: { kind: "page_content" } } })]),
      query: () => windowOf([{ ...row("r1", "Pretty"), cover: { assetId: "a1" } }]),
    });
    using _fetch = stubGlobal("fetch", share.fetch);
    await using screen = await render(<SharedDatabase {...props} />, { router: "/" });

    await expect.element(screen.getByRole("link", { name: "Pretty" })).toBeVisible();
    const image = screen.container.querySelector("img")!;
    const src = new URL(image.getAttribute("src")!, "https://host.example");
    expect(src.pathname).toBe("/api/shared-page/asset");
    expect(Object.fromEntries(src.searchParams)).toEqual({
      share: "cred.sig",
      page: "page1",
      id: "a1",
      block: "blk1",
      view: "v1",
      row: "r1",
    });
    image.dispatchEvent(new Event("error"));
    await vi.waitFor(() => expect(screen.container.querySelector("img")).toBeNull());
  });

  it("steps the agenda month by month and sends the range", async () => {
    const share = shareFetch({
      database: () =>
        description([
          view("v1", "calendar", { layout: { datePropertyId: "d" } }, [{ propertyId: "d" }]),
        ]),
      query: () => windowOf([]),
    });
    using _fetch = stubGlobal("fetch", share.fetch);
    await using screen = await render(<SharedDatabase {...props} />, { router: "/" });

    await expect.element(screen.getByText("Nothing this month.")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Previous month" }));
    await userEvent.click(screen.getByRole("button", { name: "Today" }));
    const ranges = share.queries().map((call) => [call.params.get("from"), call.params.get("to")]);
    expect(ranges).toHaveLength(3);
    const [now, previous, again] = ranges;
    expect(now![0]).toMatch(/^\d{4}-\d{2}-01$/);
    expect(previous![0]! < now![0]!).toBe(true);
    expect(previous![1]! < now![0]!).toBe(true);
    expect(again).toEqual(now);
  });

  it("files agenda rows under their start day", async () => {
    const share = shareFetch({
      database: () => description([view("v1", "timeline", { layout: { startPropertyId: "d" } })]),
      query: (call) => {
        const from = call.params.get("from")!;
        return windowOf([row("r1", "Launch", { d: { start: `${from.slice(0, 7)}-15` } })]);
      },
    });
    using _fetch = stubGlobal("fetch", share.fetch);
    await using screen = await render(<SharedDatabase {...props} />, { router: "/" });
    await expect.element(screen.getByRole("link", { name: "Launch" })).toBeVisible();
    expect(screen.container.querySelectorAll("h4")).toHaveLength(1);
  });
});
