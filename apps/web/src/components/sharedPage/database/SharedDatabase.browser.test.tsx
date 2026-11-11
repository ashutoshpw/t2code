import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render, stubGlobal } from "../../../../test/render";
import SharedDatabase, { type SharedDatabaseProps } from "./SharedDatabase";
import {
  description,
  refuse,
  row,
  shareFetch,
  view,
  window as windowOf,
} from "./sharedDatabase.testkit";

const props: SharedDatabaseProps = {
  blockId: "blk1",
  pageId: "page1",
  credential: "cred.sig",
  layout: "inline",
  rowHref: (blockId, viewId, rowId) =>
    `/shared-page?block=${blockId}&view=${viewId}&row=${rowId}#cred.sig`,
  openRow: () => {},
};

const tableView = view("v1", "table", {}, [{ propertyId: "n", width: 120 }]);

describe("SharedDatabase", () => {
  it("loads the description, then the first window, with the credential in a header only", async () => {
    const share = shareFetch({
      database: () => description([tableView]),
      query: () => windowOf([row("r1", "Write docs", { n: 3 })]),
    });
    using _fetch = stubGlobal("fetch", share.fetch);
    await using screen = await render(<SharedDatabase {...props} />, { router: "/" });

    await expect.element(screen.getByRole("heading", { name: "Tasks" })).toBeVisible();
    await expect.element(screen.getByRole("link", { name: "Write docs" })).toBeVisible();
    await expect.element(screen.getByRole("columnheader", { name: "Score" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Write docs" }).element().getAttribute("href")).toBe(
      "/shared-page?block=blk1&view=v1&row=r1#cred.sig",
    );
    for (const call of share.calls) {
      expect(call.headers["x-t2-page-share"]).toBe("cred.sig");
      expect(call.params.has("share")).toBe(false);
      expect(call.params.get("block")).toBe("blk1");
      expect(call.params.get("page")).toBe("page1");
    }
    expect(share.queries()[0]!.params.get("view")).toBe("v1");
  });

  it("switches views with a new query and offers nothing that edits", async () => {
    const share = shareFetch({
      database: () => description([tableView, view("v2", "list")]),
      query: (call) =>
        windowOf([
          row(
            call.params.get("view") === "v1" ? "r1" : "r2",
            call.params.get("view") === "v1" ? "In table" : "In list",
          ),
        ]),
    });
    using _fetch = stubGlobal("fetch", share.fetch);
    await using screen = await render(<SharedDatabase {...props} />, { router: "/" });

    await expect.element(screen.getByRole("link", { name: "In table" })).toBeVisible();
    await userEvent.click(screen.getByRole("tab", { name: "List" }));
    await expect.element(screen.getByRole("link", { name: "In list" })).toBeVisible();
    expect(share.queries().map((call) => call.params.get("view"))).toEqual(["v1", "v2"]);
    expect(
      screen.container.querySelector("input, textarea, select, [contenteditable='true']"),
    ).toBeNull();
    expect(screen.getByRole("checkbox").elements()).toHaveLength(0);
    expect(screen.getByRole("textbox").elements()).toHaveLength(0);
  });

  it("appends the next window without duplicates", async () => {
    const share = shareFetch({
      database: () => description([tableView]),
      query: (call) =>
        call.params.get("cursor") === "c1"
          ? windowOf([row("r2", "Second"), row("r3", "Third")])
          : windowOf([row("r1", "First"), row("r2", "Second")], { nextCursor: "c1" }),
    });
    using _fetch = stubGlobal("fetch", share.fetch);
    await using screen = await render(<SharedDatabase {...props} />, { router: "/" });

    await userEvent.click(screen.getByRole("button", { name: "Show more" }));
    await expect.element(screen.getByRole("link", { name: "Third" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Second" }).elements()).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Show more" }).elements()).toHaveLength(0);
  });

  it("restarts from the first window when a continuation is refused, and gives up if that fails too", async () => {
    let fresh = true;
    const share = shareFetch({
      database: () => description([tableView]),
      query: (call) => {
        if (call.params.get("cursor") === "c1") return refuse("unavailable");
        if (fresh) {
          fresh = false;
          return windowOf([row("r1", "Before")], { nextCursor: "c1" });
        }
        return windowOf([row("r9", "After restart")]);
      },
    });
    using _fetch = stubGlobal("fetch", share.fetch);
    await using screen = await render(<SharedDatabase {...props} />, { router: "/" });

    await userEvent.click(screen.getByRole("button", { name: "Show more" }));
    await expect.element(screen.getByRole("link", { name: "After restart" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Before" }).elements()).toHaveLength(0);
    expect(share.queries().map((call) => call.params.get("cursor"))).toEqual([null, "c1", null]);
  });

  it("says when the database is not part of the link while the rest of the page lives", async () => {
    const share = shareFetch({ database: () => refuse("unavailable") });
    using _fetch = stubGlobal("fetch", share.fetch);
    await using screen = await render(<SharedDatabase {...props} />, { router: "/" });
    await expect.element(screen.getByText("This database isn't part of this link.")).toBeVisible();
  });

  it("explains an empty link and a revoked one", async () => {
    const empty = shareFetch({ database: () => description([]) });
    {
      using _fetch = stubGlobal("fetch", empty.fetch);
      await using screen = await render(<SharedDatabase {...props} />, { router: "/" });
      await expect
        .element(screen.getByText("Nothing in this database is available on this link."))
        .toBeVisible();
    }
    const revoked = shareFetch({ database: () => refuse("inactive") });
    using _fetch = stubGlobal("fetch", revoked.fetch);
    await using screen = await render(<SharedDatabase {...props} />, { router: "/" });
    await expect.element(screen.getByText(/This link no longer works/)).toBeVisible();
    expect(revoked.queries()).toHaveLength(0);
  });

  it("shows the link ending in the middle of a view", async () => {
    const share = shareFetch({
      database: () => description([tableView]),
      query: () => refuse("inactive"),
    });
    using _fetch = stubGlobal("fetch", share.fetch);
    await using screen = await render(<SharedDatabase {...props} />, { router: "/" });
    await expect.element(screen.getByText(/This link no longer works/)).toBeVisible();
  });
});
