import { SpaceBlockId, SpacePageId } from "@t2code/contracts/spaces";
import * as Schema from "effect/Schema";
import { SpaceSharedPage } from "@t2code/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render, stubGlobal } from "../../../test/render";
import { SharedPage } from "./SharedPage";
import {
  description,
  row,
  shareFetch,
  view,
  window as windowOf,
} from "./database/sharedDatabase.testkit";

const NOW = "2026-10-29T00:00:00.000Z";
const encode = Schema.encodeSync(Schema.toCodecJson(SpaceSharedPage));

const databaseBlock = {
  id: SpaceBlockId.make("db-b"),
  parentId: null,
  order: "b",
  type: "database",
  version: 1,
  content: { databaseId: "db1", viewIds: ["v1"] },
};

const sharedPage = (
  id: string,
  title: string,
  text: string,
  breadcrumb: string[],
  extraBlocks: ReadonlyArray<typeof databaseBlock> = [],
) =>
  encode({
    rootPageId: SpacePageId.make("root"),
    expiresAt: NOW,
    page: { id: SpacePageId.make(id), title, updatedAt: NOW },
    window: {
      revision: 1,
      blocks: [
        {
          id: SpaceBlockId.make(`${id}-b`),
          parentId: null,
          order: "a",
          type: "paragraph",
          version: 1,
          content: { runs: [{ text, marks: [] }] },
        },
        ...extraBlocks,
      ],
    },
    breadcrumb: breadcrumb.map((crumb) => ({
      id: SpacePageId.make(crumb),
      title: crumb === "root" ? "Handbook" : "Setup",
    })),
    children:
      id === "root" ? [{ id: SpacePageId.make("child"), title: "Setup", updatedAt: NOW }] : [],
  });

function fakeFetch(inactive = false) {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = new URL(String(input), "https://host.example");
    if (inactive) return Response.json({ reason: "inactive", message: "ended" }, { status: 403 });
    const page = url.searchParams.get("page");
    return Response.json(
      page === "child"
        ? sharedPage("child", "Setup", "Install it", ["root", "child"])
        : sharedPage("root", "Handbook", "Welcome aboard", ["root"]),
    );
  });
}

describe("SharedPage", () => {
  it("shows the page read-only and opens a sub-page with the credential kept", async () => {
    const fetch = fakeFetch();
    using _fetch = stubGlobal("fetch", fetch);
    await using screen = await render(<SharedPage />, { router: "/?x=1#cred.sig" });

    await expect.element(screen.getByRole("heading", { name: "Handbook" })).toBeVisible();
    await expect.element(screen.getByText("Welcome aboard")).toBeVisible();
    expect(screen.container.querySelector("[contenteditable='true']")).toBeNull();
    expect(String(fetch.mock.calls[0]![0])).not.toContain("cred.sig");
    expect(fetch.mock.calls[0]![1]?.headers).toEqual({ "x-t2-page-share": "cred.sig" });

    await userEvent.click(screen.getByRole("link", { name: "Setup" }));
    await expect.element(screen.getByText("Install it")).toBeVisible();
    expect(screen.router!.state.location.hash).toBe("cred.sig");
    await expect.element(screen.getByRole("link", { name: "Handbook" })).toBeVisible();
  });

  it("explains an ended link", async () => {
    using _fetch = stubGlobal("fetch", fakeFetch(true));
    await using screen = await render(<SharedPage />, { router: "/#cred.sig" });
    await expect.element(screen.getByText("This link no longer works")).toBeVisible();
  });

  it("shows a database block read-only and opens one of its rows as a page", async () => {
    const share = shareFetch({
      page: () => sharedPage("root", "Handbook", "Welcome aboard", ["root"], [databaseBlock]),
      database: () => description([view("v1", "table")]),
      query: () => windowOf([row("r1", "Ship it")]),
      row: () => ({
        row: row("r1", "Ship it"),
        relatedPages: {},
        options: {},
        window: { revision: 1, blocks: [] },
        breadcrumb: [
          { id: "root", title: "Handbook" },
          { id: "r1", title: "Ship it" },
        ],
      }),
    });
    using _fetch = stubGlobal("fetch", share.fetch);
    await using screen = await render(<SharedPage />, { router: "/#cred.sig" });

    await expect.element(screen.getByText("Welcome aboard")).toBeVisible();
    await expect.element(screen.getByRole("heading", { name: "Tasks" })).toBeVisible();
    const link = screen.getByRole("link", { name: "Ship it" });
    await expect.element(link).toBeVisible();
    const href = new URL(link.element().getAttribute("href")!, "https://host.example");
    expect(Object.fromEntries(href.searchParams)).toEqual({
      page: "root",
      block: "db-b",
      view: "v1",
      row: "r1",
    });
    expect(href.hash).toBe("#cred.sig");

    await userEvent.click(link);
    await expect.element(screen.getByRole("heading", { name: "Ship it" })).toBeVisible();
    expect(screen.router!.state.location.hash).toBe("cred.sig");
    expect(share.calls.filter((call) => call.route.endsWith("/row"))).toHaveLength(1);
  });
});
