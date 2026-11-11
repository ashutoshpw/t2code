import "~/index.css";

import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { SpaceKnownDatabaseProperty, SpacePageId } from "@t2code/contracts/spaces";

import { render } from "../../../../test/render";
import { OptionEditor } from "./OptionEditor";

const known = {
  id: "prop-select",
  name: "Stage",
  type: "select",
  config: { options: [{ id: "a", name: "Alpha", color: "blue" }] },
} as unknown as SpaceKnownDatabaseProperty;

describe("OptionEditor without a database surface", () => {
  it("picks an option and offers no create row", async () => {
    const onCommit = vi.fn();
    // router: false - the editor needs no routes and no database surface, as on a row page.
    await using screen = await render(
      <div className="relative mt-4 h-8 w-48">
        <OptionEditor
          known={known}
          value={undefined}
          pageId={"page-1" as SpacePageId}
          variant="field"
          relatedPages={{}}
          onCommit={onCommit}
          onClose={vi.fn()}
        />
      </div>,
      { router: false },
    );
    await expect.element(page.getByRole("combobox", { name: "Search Stage" })).toBeVisible();
    await userEvent.type(page.getByRole("combobox", { name: "Search Stage" }), "Zed");
    await expect.element(page.getByText("No options")).toBeVisible();
    await userEvent.keyboard("{Backspace}{Backspace}{Backspace}");
    await userEvent.click(page.getByRole("option", { name: "Alpha" }));
    expect(onCommit).toHaveBeenCalledWith("a", undefined, undefined);
    void screen;
  });
});
