import { EnvironmentId } from "@t2code/contracts";
import { SpaceId, SpacePageId, type SpacePageSummary } from "@t2code/contracts/spaces";
import type { SpaceRootReorder } from "@t2code/client-runtime/spaces";
import { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";

const mocks = vi.hoisted(() => ({
  executeAtomQuery: vi.fn(),
}));

vi.mock(import("@t2code/client-runtime/state/runtime"), async (original) => ({
  ...(await original()),
  executeAtomQuery: mocks.executeAtomQuery as never,
}));

vi.mock(import("../state/spaces"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useSpacesAvailability: () => "writable",
    spacesEnvironment: {
      ...actual.spacesEnvironment,
      page: (input: unknown) => input,
      updatePage: { permissionAtom: () => Atom.make(true) },
    } as never,
  };
});

import { EditableTitle } from "./SpaceLibraryControls";

// The class ProseMirror puts on the editable surface; the title looks the body up by it.
// oxlint-disable-next-line shadcn/no-unknown-classes -- a TipTap class, not a Tailwind one
const proseMirrorClass = "tiptap";
const environmentId = EnvironmentId.make("env");
const page: SpacePageSummary = {
  id: SpacePageId.make("page"),
  spaceId: SpaceId.make("space"),
  title: "Page",
  revision: 1,
  rootOrder: "1",
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:00:00.000Z",
};

function setup() {
  mocks.executeAtomQuery.mockReset();
  mocks.executeAtomQuery.mockResolvedValue({
    _tag: "Success",
    value: { page: { ...page, revision: 2 } },
  });
  const snapshot = { busy: false, journal: { pending: null } };
  const renamePage = vi.fn<(page: SpacePageSummary, title: string) => Promise<void>>(
    async () => {},
  );
  const owner = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    renamePage,
  } as unknown as SpaceRootReorder;
  const title = (
    <section>
      <EditableTitle
        environmentId={environmentId}
        page={page}
        current={() => true}
        owner={owner}
        autoFocus={false}
      />
      <div data-space-editor="">
        <div
          className={proseMirrorClass}
          contentEditable
          suppressContentEditableWarning
          aria-label="Body"
        >
          <p data-space-block="">Body text</p>
        </div>
      </div>
    </section>
  );
  return { title, renamePage };
}

describe("EditableTitle", () => {
  it("moves the caret to the start of the body once the rename has finished", async () => {
    const { title, renamePage } = setup();
    // The title needs no route.
    await using screen = await render(title, { router: false });
    await userEvent.type(screen.getByRole("textbox", { name: "Page title" }), "s{Enter}");
    await expect.element(screen.getByLabelText("Body")).toHaveFocus();
    expect(renamePage).toHaveBeenCalledWith(page, "sPage");
    const selection = window.getSelection();
    expect(selection?.anchorOffset).toBe(0);
    expect(
      document.querySelector("[data-space-block]")?.contains(selection?.anchorNode ?? null),
    ).toBe(true);
  });

  it("renames from the page's fresh revision when the previous rename has not been refetched yet", async () => {
    const { title, renamePage } = setup();
    // The title needs no route.
    await using screen = await render(title, { router: false });
    const field = screen.getByRole("textbox", { name: "Page title" });
    await userEvent.type(field, "a");
    await userEvent.tab();
    await vi.waitFor(() => expect(renamePage).toHaveBeenCalledTimes(1));
    expect(mocks.executeAtomQuery).not.toHaveBeenCalled();
    await userEvent.type(field, "b");
    await userEvent.tab();
    await vi.waitFor(() => expect(renamePage).toHaveBeenCalledTimes(2));
    expect(mocks.executeAtomQuery).toHaveBeenCalledTimes(1);
    expect(renamePage.mock.calls[1]?.[0].revision).toBe(2);
  });
});
