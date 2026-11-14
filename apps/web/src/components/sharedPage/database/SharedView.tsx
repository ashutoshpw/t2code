// @effect-diagnostics globalDate:off -- Starts the agenda on the viewer's current month.
import { addMonths, isoDay, startOfMonth } from "@t2code/client-runtime/spaces";
import type { SpaceSharedDataSource, SpaceSharedDatabaseView } from "@t2code/contracts";
import { useState } from "react";

import { Skeleton } from "~/components/ui/skeleton";
import { monthRange } from "./agenda";
import { sharedKnownProperties } from "./cells";
import { ProblemNote, type SharedEnv, type ViewProps } from "./parts";
import { SharedAgenda } from "./SharedAgenda";
import { SharedChart } from "./SharedChart";
import { SharedFeed } from "./SharedFeed";
import { SharedForm } from "./SharedForm";
import { SharedBoard } from "./SharedBoard";
import { SharedGallery } from "./SharedGallery";
import { SharedList } from "./SharedList";
import { SharedTable } from "./SharedTable";
import { useSharedWindow } from "./useSharedWindow";
import { isViewType, viewModel, type ViewType } from "./viewModel";

interface SharedViewProps {
  readonly env: SharedEnv;
  readonly view: SpaceSharedDatabaseView;
  readonly source: SpaceSharedDataSource;
}

/** The active view. The parent keys it by view id, so switching starts a fresh walk. */
export function SharedView(props: SharedViewProps) {
  const { type } = props.view;
  if (!isViewType(type))
    return (
      <p className="py-4 text-muted-foreground text-sm">
        This view type can't be shown on a shared link.
      </p>
    );
  // A form never fetches a window: its questions come from the form route.
  if (type === "form")
    return <SharedForm env={props.env} view={props.view} source={props.source} />;
  return <ViewWindow {...props} type={type} />;
}

function ViewWindow({ env, view, source, type }: SharedViewProps & { readonly type: ViewType }) {
  const agenda = type === "calendar" || type === "timeline";
  const [month, setMonth] = useState(() => startOfMonth(isoDay(Date.now(), env.zone)));
  const range = agenda ? monthRange(month) : undefined;
  const { state, loadMore, loadBucket } = useSharedWindow({
    credential: env.credential,
    pageId: env.pageId,
    blockId: env.blockId,
    viewId: view.id,
    zone: env.zone,
    ...(range === undefined ? {} : { range }),
  });
  if (state.status === "loading")
    return (
      <div role="status" aria-label="Loading rows" className="flex flex-col gap-1.5 py-2">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-7 w-full" />
        ))}
      </div>
    );
  if (state.status === "failed") return <ProblemNote problem={state.problem} />;

  const { data } = state;
  const props: ViewProps = {
    env,
    view,
    source,
    model: viewModel(view, source),
    data,
    known: sharedKnownProperties(source, data.options),
    busy: state.busy,
    moreProblem: state.moreProblem,
    loadMore,
    loadBucket,
  };
  // A chart window has buckets with counts and no rows, so it must not reach the empty check.
  if (type === "chart") return <SharedChart {...props} />;
  if (agenda && range !== undefined)
    return (
      <SharedAgenda
        props={props}
        month={month}
        range={range}
        onStep={(delta) =>
          setMonth(
            delta === 0 ? startOfMonth(isoDay(Date.now(), env.zone)) : addMonths(month, delta),
          )
        }
      />
    );
  const empty =
    data.groups === null ? data.rows.length === 0 : data.groups.every((b) => b.rows.length === 0);
  if (empty) return <p className="py-4 text-muted-foreground text-sm">No rows to show.</p>;
  switch (type) {
    case "table":
      return <SharedTable {...props} />;
    case "board":
      return <SharedBoard {...props} />;
    case "list":
      return <SharedList {...props} />;
    case "gallery":
      return <SharedGallery {...props} />;
    case "feed":
      return <SharedFeed {...props} />;
    default:
      return null;
  }
}
