import { ArrowUpRightIcon } from "lucide-react";

import type { DatabaseBlockHost } from "../blocks/DatabaseBlockHost";
import type { DatabaseModel } from "../data/useDatabaseModel";

/** A linked view's title: a link to the home page; the database is renamed there, not here. */
export function LinkedHeader({
  model,
  host,
}: {
  readonly model: DatabaseModel;
  readonly host: DatabaseBlockHost;
}) {
  const { home, title, spaceId } = model.database;
  const label = title.trim() || "Untitled database";
  if (home === null)
    return <p className="px-1 text-sm font-medium text-muted-foreground">{label}</p>;
  return (
    <button
      type="button"
      className="inline-flex max-w-full items-center gap-1 rounded-sm px-1 text-sm font-medium text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      onClick={() =>
        host.openPage({ environmentId: model.environmentId, spaceId, pageId: home.pageId })
      }
    >
      <ArrowUpRightIcon className="size-3.5 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}
