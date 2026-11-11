import { useContext } from "react";

import { DraftInput } from "~/components/ui/draft-input";
import type { DatabaseModel } from "../data/useDatabaseModel";
import { DatabaseActionsContext } from "./context";

export function DatabaseTitle({ model }: { readonly model: DatabaseModel }) {
  const actions = useContext(DatabaseActionsContext);
  const writable = model.permissions.title;
  return (
    <DraftInput
      aria-label="Database title"
      placeholder="Untitled database"
      readOnly={!writable}
      value={model.database.title}
      onCommit={(title) => actions?.renameDatabase(title)}
    />
  );
}
