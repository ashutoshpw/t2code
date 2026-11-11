import type { ReactNode } from "react";
import type { ViewPatch } from "@t2code/client-runtime/spaces";
import type {
  SpaceDataSource,
  SpaceDatabaseView,
  SpaceKnownDatabaseView,
} from "@t2code/contracts/spaces";

/** What a view type's Layout section receives; it writes `{ layout: { ...known.layout, ...change } }`. */
export interface LayoutSectionProps {
  readonly view: SpaceDatabaseView;
  readonly known: SpaceKnownDatabaseView | null;
  readonly dataSource: SpaceDataSource;
  readonly editView: (patch: ViewPatch) => void;
  readonly disabled: boolean;
}

/** One labelled setting row of a Layout section. */
export function LayoutRow({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1 text-sm">
      <span className="min-w-0 truncate">{label}</span>
      {children}
    </div>
  );
}
