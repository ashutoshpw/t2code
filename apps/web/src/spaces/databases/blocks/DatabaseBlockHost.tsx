import { createContext, useContext, type ReactNode } from "react";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpacePageId } from "@t2code/contracts/spaces";
import type { SpacePageNavigationTarget } from "@t2code/client-runtime/spaces";

import type { SpaceEditorAdapter } from "../../adapter";
import type { SpaceDocumentController } from "../../documentController";

/** One object per document surface, created once and never replaced. */
export interface DatabaseBlockHost {
  readonly environmentId: EnvironmentId;
  readonly pageId: SpacePageId;
  readonly controller: SpaceDocumentController;
  readonly adapter: SpaceEditorAdapter;
  openPage(target: SpacePageNavigationTarget): void;
}

export type DatabaseSurfaceHost = Pick<DatabaseBlockHost, "environmentId" | "openPage">;

export type DatabaseLayout = "inline" | "page";

const DatabaseBlockHostContext = createContext<DatabaseBlockHost | null>(null);
const DatabaseLayoutContext = createContext<DatabaseLayout>("inline");
const DatabasePageEditableContext = createContext(false);

export function DatabaseBlockHostProvider({
  host,
  layout,
  editable,
  children,
}: {
  readonly host: DatabaseBlockHost | null;
  readonly layout: DatabaseLayout;
  readonly editable: boolean;
  readonly children: ReactNode;
}) {
  return (
    <DatabaseBlockHostContext.Provider value={host}>
      <DatabaseLayoutContext.Provider value={layout}>
        <DatabasePageEditableContext.Provider value={editable}>
          {children}
        </DatabasePageEditableContext.Provider>
      </DatabaseLayoutContext.Provider>
    </DatabaseBlockHostContext.Provider>
  );
}

export const useDatabaseBlockHost = () => useContext(DatabaseBlockHostContext);
export const useDatabaseLayout = () => useContext(DatabaseLayoutContext);
export const useDatabasePageEditable = () => useContext(DatabasePageEditableContext);
