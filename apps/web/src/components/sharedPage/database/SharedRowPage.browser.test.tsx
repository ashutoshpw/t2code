import { describe, expect, it } from "vite-plus/test";

import "~/index.css";

import { render, stubGlobal } from "../../../../test/render";
import { SharedRowPage, type SharedRowTarget } from "./SharedRowPage";
import { description, refuse, row, shareFetch, view } from "./sharedDatabase.testkit";

const target: SharedRowTarget = {
  credential: "cred.sig",
  pageId: "page1",
  blockId: "blk1",
  viewId: "v1",
  rowId: "r1",
};
const hrefFor = (pageId: string) => `/shared-page?page=${pageId}#cred.sig`;

const block = (id: string, type: string, content: object) => ({
  id,
  parentId: null,
  order: id,
  type,
  version: 1,
  content,
});

const rowPage = {
  row: row("r1", "Ship it", { n: 7, st: "o1", d: { start: "2026-11-20" } }),
  relatedPages: {},
  options: { st: [{ id: "o1", name: "Todo", color: "red" }] },
  window: {
    revision: 1,
    blocks: [
      block("b1", "paragraph", { runs: [{ text: "Row body text", marks: [] }] }),
      block("b2", "image", { assetId: "a7" }),
      block("b3", "child_page", { pageId: "secret" }),
      block("b4", "database", { databaseId: "other", viewIds: ["x"] }),
    ],
  },
  breadcrumb: [
    { id: "page1", title: "Home" },
    { id: "r1", title: "Ship it" },
  ],
};

const described = () =>
  description([view("v1", "table", {}, [{ propertyId: "n" }, { propertyId: "st" }])]);

describe("SharedRowPage", () => {
  it("shows the row's properties above a read-only body with row-form media", async () => {
    const share = shareFetch({ database: described, row: () => rowPage });
    using _fetch = stubGlobal("fetch", share.fetch);
    await using screen = await render(
      <SharedRowPage target={target} hrefFor={hrefFor} onOpen={() => {}} />,
      { router: "/" },
    );

    await expect.element(screen.getByRole("heading", { name: "Ship it" })).toBeVisible();
    await expect.element(screen.getByText("Score")).toBeVisible();
    await expect.element(screen.getByText("Todo")).toBeVisible();
    // The date came with the row but is not a view column: it follows the columns.
    await expect.element(screen.getByText("Due")).toBeVisible();
    await expect.element(screen.getByText("Row body text")).toBeVisible();
    expect(screen.container.querySelector("[contenteditable='true']")).toBeNull();

    const src = new URL(
      screen.container.querySelector("img")!.getAttribute("src")!,
      "https://host.example",
    );
    expect(Object.fromEntries(src.searchParams)).toEqual({
      share: "cred.sig",
      page: "page1",
      id: "a7",
      block: "blk1",
      view: "v1",
      row: "r1",
    });
    await expect.element(screen.getByText("Sub-page (not part of this link)")).toBeVisible();
    await expect.element(screen.getByText("Database (not part of this link)")).toBeVisible();
    expect(screen.container.textContent).not.toContain("secret");

    await expect.element(screen.getByRole("link", { name: "Home" })).toBeVisible();
    const call = share.calls.find((entry) => entry.route.endsWith("/row"))!;
    expect(call.headers["x-t2-page-share"]).toBe("cred.sig");
    expect(Object.fromEntries(call.params)).toMatchObject({
      block: "blk1",
      view: "v1",
      row: "r1",
      page: "page1",
    });
  });

  it("says when the row is no longer on the link", async () => {
    const share = shareFetch({ database: described, row: () => refuse("unavailable") });
    using _fetch = stubGlobal("fetch", share.fetch);
    await using screen = await render(
      <SharedRowPage target={target} hrefFor={hrefFor} onOpen={() => {}} />,
      { router: "/" },
    );
    await expect.element(screen.getByText("This page isn't available on this link.")).toBeVisible();
  });

  it("shows a revoked link", async () => {
    const share = shareFetch({ database: () => refuse("inactive"), row: () => refuse("inactive") });
    using _fetch = stubGlobal("fetch", share.fetch);
    await using screen = await render(
      <SharedRowPage target={target} hrefFor={hrefFor} onOpen={() => {}} />,
      { router: "/" },
    );
    await expect.element(screen.getByText(/This link no longer works/)).toBeVisible();
  });
});
