import { useState, type ReactNode } from "react";
import { SpaceBlockId, SpaceDatabaseId, SpacePageId, SpaceViewId } from "@t2code/contracts/spaces";
import { vi } from "vite-plus/test";

import type { SpaceEditorAdapter } from "../../adapter";
import type { SpaceDocumentController } from "../../documentController";
import type { DatabaseBlockActions } from "../blocks/actions";
import DatabaseBlock from "../blocks/DatabaseBlock";
import {
  DatabaseBlockHostProvider,
  type DatabaseBlockHost,
  type DatabaseLayout,
} from "../blocks/DatabaseBlockHost";
import { TEST_ENVIRONMENT } from "./environment";
import { FIXTURE_IDS } from "./fixtures";

export { TEST_ENVIRONMENT } from "./environment";

export interface FakePageSession {
  dirty: boolean;
  pending: boolean;
}

/** Just what the database host reads: save state, the page id and the save call. */
export function fakeController(session: FakePageSession = { dirty: false, pending: false }) {
  const listeners = new Set<() => void>();
  let snapshot = { ...session };
  const controller = {
    session: {
      key: { environmentId: TEST_ENVIRONMENT, pageId: SpacePageId.make("page-1") },
      getSnapshot: () => snapshot,
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => ({ metadata: { page: { spaceId: FIXTURE_IDS.space } } }),
    save: vi.fn(async () => {}),
  };
  return {
    controller: controller as unknown as SpaceDocumentController,
    save: controller.save,
    set(next: FakePageSession) {
      snapshot = { ...next };
      for (const listener of listeners) listener();
    },
  };
}

export function testHost(
  controller: SpaceDocumentController,
  adapter: SpaceEditorAdapter | null = null,
): DatabaseBlockHost {
  return {
    environmentId: TEST_ENVIRONMENT,
    pageId: SpacePageId.make("page-1"),
    controller,
    adapter: adapter as never,
    openPage: vi.fn(),
  };
}

export function TestHostProvider({
  host,
  layout = "inline",
  editable = true,
  children,
}: {
  readonly host: DatabaseBlockHost;
  readonly layout?: DatabaseLayout;
  readonly editable?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <DatabaseBlockHostProvider host={host} layout={layout} editable={editable}>
      {children}
    </DatabaseBlockHostProvider>
  );
}

/** A database block whose view list lives in local state, as the page document would hold it. */
export function DatabaseHarness({
  host,
  initialViewIds,
  layout = "inline",
  editable = true,
  onSetViews,
}: {
  readonly host: DatabaseBlockHost;
  readonly initialViewIds: ReadonlyArray<string>;
  readonly layout?: DatabaseLayout;
  readonly editable?: boolean;
  readonly onSetViews?: (viewIds: ReadonlyArray<string>) => void;
}) {
  const [viewIds, setViewIds] = useState(initialViewIds.map((id) => SpaceViewId.make(id)));
  const [actions] = useState<DatabaseBlockActions>(() => ({
    setViews: (next) => {
      onSetViews?.(next);
      setViewIds([...next]);
      return true;
    },
    remove: () => true,
  }));
  return (
    <TestHostProvider host={host} layout={layout} editable={editable}>
      <DatabaseBlock
        blockId={SpaceBlockId.make("block-1")}
        databaseId={SpaceDatabaseId.make(FIXTURE_IDS.database)}
        viewIds={viewIds}
        actions={actions}
      />
    </TestHostProvider>
  );
}
