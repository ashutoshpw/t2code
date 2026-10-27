import type { SpacePageSummary } from "@t2code/contracts/spaces";
import type { SpaceNavigationWindow } from "@t2code/client-runtime/spaces";

interface WindowRow {
  kind: "window";
  key: string;
  depth: number;
  window: SpaceNavigationWindow;
  parentTitle: string | null;
}

interface PageRow extends Omit<WindowRow, "kind"> {
  kind: "page";
  page: SpacePageSummary;
  expanded: boolean;
}

export type SpacePageTreeRow = PageRow | WindowRow;

export function spacePageTreeRows(windows: readonly SpaceNavigationWindow[]) {
  const byParent = new Map(windows.map((window) => [window.parentPageId, window]));
  const rows: SpacePageTreeRow[] = [];
  const visit = (window: SpaceNavigationWindow, depth: number, parentTitle: string | null) => {
    if (!window.error && window.data) {
      for (const page of window.data.items) {
        const children = byParent.get(page.id);
        rows.push({
          kind: "page",
          key: JSON.stringify(["page", page.id]),
          depth,
          page,
          window,
          parentTitle,
          expanded: children !== undefined,
        });
        if (children) visit(children, depth + 1, page.title || "Untitled page");
      }
    }
    if (
      window.error ||
      !window.data ||
      window.data.items.length === 0 ||
      window.cursor ||
      window.data.nextCursor
    )
      rows.push({
        kind: "window",
        key: JSON.stringify(["window", window.parentPageId]),
        depth,
        window,
        parentTitle,
      });
  };
  const root = byParent.get(null);
  if (root) visit(root, 0, null);
  return rows;
}
