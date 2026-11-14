import { SpaceBlockId, SpaceCursor, SpacePageId, type SpaceBlock } from "@t2code/contracts/spaces";
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

const tabsBlocks: SpaceBlock[] = [
  {
    id: SpaceBlockId.make("tabs-b"),
    parentId: null,
    order: "c",
    type: "tabs",
    version: 1,
    content: {},
  },
  ...["One", "Two"].map((title, i) => ({
    id: SpaceBlockId.make(`pane-${i}`),
    parentId: SpaceBlockId.make("tabs-b"),
    order: String(i),
    type: "tab_pane",
    version: 1 as const,
    content: { title },
  })),
  ...["First pane text", "Second pane text"].map((text, i) => ({
    id: SpaceBlockId.make(`pane-text-${i}`),
    parentId: SpaceBlockId.make(`pane-${i}`),
    order: "a",
    type: "paragraph",
    version: 1 as const,
    content: { runs: [{ text, marks: [] }] },
  })),
];

const syncedRef = (id: string, order: string, source: string): SpaceBlock => ({
  id: SpaceBlockId.make(id),
  parentId: null,
  order,
  type: "synced_ref",
  version: 1,
  content: { sourceBlockId: SpaceBlockId.make(source) },
});
const syncedOriginal: NonNullable<SpaceSharedPage["synced"]>[number] = {
  sourceBlockId: SpaceBlockId.make("orig"),
  complete: true,
  blocks: [
    {
      id: SpaceBlockId.make("orig"),
      parentId: null,
      order: "a",
      type: "synced_block",
      version: 1,
      content: {},
    },
    {
      id: SpaceBlockId.make("orig-text"),
      parentId: SpaceBlockId.make("orig"),
      order: "a",
      type: "paragraph",
      version: 1,
      content: { runs: [{ text: "Synced words", marks: [] }] },
    },
  ],
};

const sharedPage = (
  id: string,
  title: string,
  text: string,
  breadcrumb: string[],
  extraBlocks: ReadonlyArray<SpaceBlock> = [],
  synced: NonNullable<SpaceSharedPage["synced"]> = [],
  window: { readonly nextCursor?: string; readonly omitLead?: boolean } = {},
) =>
  encode({
    rootPageId: SpacePageId.make("root"),
    expiresAt: NOW,
    page: { id: SpacePageId.make(id), title, updatedAt: NOW },
    window: {
      revision: 1,
      blocks: [
        ...(window.omitLead
          ? []
          : [
              {
                id: SpaceBlockId.make(`${id}-b`),
                parentId: null,
                order: "a",
                type: "paragraph" as const,
                version: 1 as const,
                content: { runs: [{ text, marks: [] }] },
              },
            ]),
        ...extraBlocks,
      ],
    },
    ...(synced.length === 0 ? {} : { synced }),
    ...(window.nextCursor === undefined ? {} : { nextCursor: SpaceCursor.make(window.nextCursor) }),
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
        : sharedPage("root", "Handbook", "Welcome aboard", ["root"], tabsBlocks),
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
    await expect.element(screen.getByText("First pane text")).toBeVisible();
    await userEvent.click(screen.getByRole("tab", { name: "Two" }));
    await expect.element(screen.getByText("Second pane text")).toBeVisible();
    await expect.element(screen.getByText("First pane text")).not.toBeVisible();
    expect(screen.container.querySelector("[aria-label='Add a tab']")).toBeNull();
    expect(String(fetch.mock.calls[0]![0])).not.toContain("cred.sig");
    expect(fetch.mock.calls[0]![1]?.headers).toEqual({ "x-t2-page-share": "cred.sig" });

    await userEvent.click(screen.getByRole("link", { name: "Setup" }));
    await expect.element(screen.getByText("Install it")).toBeVisible();
    expect(screen.router!.state.location.hash).toBe("cred.sig");
    await expect.element(screen.getByRole("link", { name: "Handbook" })).toBeVisible();
  });

  it("shows the original behind a synced copy and a notice when it is missing", async () => {
    const copies = [syncedRef("copy", "d", "orig"), syncedRef("lost", "e", "elsewhere")];
    using _fetch = stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          sharedPage("root", "Handbook", "Welcome aboard", ["root"], copies, [syncedOriginal]),
        ),
      ),
    );
    await using screen = await render(<SharedPage />, { router: "/#cred.sig" });
    await expect.element(screen.getByText("Synced words")).toBeVisible();
    await expect.element(screen.getByText("Synced content unavailable.")).toBeVisible();
    expect(screen.container.querySelector("[contenteditable='true']")).toBeNull();
  });

  it("keeps the original of a copy that sits in a later window", async () => {
    using _fetch = stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "https://host.example");
        if (!url.searchParams.has("cursor"))
          return Response.json(
            sharedPage("root", "Handbook", "Welcome aboard", ["root"], [], [], {
              nextCursor: "next",
            }),
          );
        return Response.json(
          sharedPage(
            "root",
            "Handbook",
            "Later words",
            ["root"],
            [syncedRef("copy", "d", "orig")],
            [syncedOriginal],
            { omitLead: true },
          ),
        );
      }),
    );
    await using screen = await render(<SharedPage />, { router: "/#cred.sig" });
    await expect.element(screen.getByText("Synced words")).toBeVisible();
    expect(screen.container.textContent).not.toContain("Synced content unavailable.");
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
