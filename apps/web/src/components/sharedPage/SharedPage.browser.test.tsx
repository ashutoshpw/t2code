import { SpaceBlockId, SpacePageId } from "@t2code/contracts/spaces";
import * as Schema from "effect/Schema";
import { SpaceSharedPage } from "@t2code/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render, stubGlobal } from "../../../test/render";
import { SharedPage } from "./SharedPage";

const NOW = "2026-10-29T00:00:00.000Z";
const encode = Schema.encodeSync(Schema.toCodecJson(SpaceSharedPage));

const sharedPage = (id: string, title: string, text: string, breadcrumb: string[]) =>
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
  return vi.fn(async (input: RequestInfo | URL) => {
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
    expect(String(fetch.mock.calls[0]![0])).toContain("share=cred.sig");

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
});
