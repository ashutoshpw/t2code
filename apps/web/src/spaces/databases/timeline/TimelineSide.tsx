import { type GroupLabel, rowTitle } from "@t2code/client-runtime/spaces";
import { memo, useRef, type PointerEvent } from "react";
import type { SpaceGroupBucket, SpacePageId } from "@t2code/contracts/spaces";

import { TimelineLineLabel } from "./TimelineLineLabel";
import type { TimelineGroupHandlers, TimelineLine } from "./timelineLines";
import { ROW_HEIGHT } from "./timelineScale";

const MIN_TABLE_WIDTH = 120;
const MAX_TABLE_WIDTH = 600;

/** The sticky title pane. Its width changes through inline style while dragging and is written once on release. */
export const TimelineSide = memo(function TimelineSide({
  lines,
  labelOf,
  groups,
  first,
  last,
  width,
  canResize,
  onOpen,
  onWidth,
}: {
  readonly lines: ReadonlyArray<TimelineLine>;
  readonly labelOf: (bucket: SpaceGroupBucket) => GroupLabel;
  readonly groups: TimelineGroupHandlers;
  readonly first: number;
  readonly last: number;
  readonly width: number;
  readonly canResize: boolean;
  readonly onOpen: (pageId: SpacePageId) => void;
  readonly onWidth: (width: number) => void;
}) {
  const pane = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startX: number; start: number; width: number } | null>(null);
  const clamp = (value: number) =>
    Math.min(MAX_TABLE_WIDTH, Math.max(MIN_TABLE_WIDTH, Math.round(value)));
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (state === null || pane.current === null) return;
    state.width = clamp(state.start + event.clientX - state.startX);
    pane.current.style.width = `${state.width}px`;
  };
  const release = (commit: boolean) => {
    const state = drag.current;
    drag.current = null;
    if (state === null) return;
    if (commit && state.width !== state.start) onWidth(state.width);
    else if (pane.current !== null) pane.current.style.width = `${state.start}px`;
  };
  return (
    <div
      ref={pane}
      role="list"
      aria-label="Items"
      className="sticky left-0 z-10 shrink-0 border-e bg-background"
      style={{ width, height: lines.length * ROW_HEIGHT }}
    >
      {lines.slice(first, last).map((line, offset) => {
        const top = (first + offset) * ROW_HEIGHT;
        if (line.kind !== "row")
          return (
            <div
              key={line.kind === "group" ? line.id : `more:${JSON.stringify(line.group)}`}
              role="presentation"
              className="absolute inset-x-0 border-b bg-muted/30"
              style={{ top, height: ROW_HEIGHT }}
            >
              <TimelineLineLabel line={line} labelOf={labelOf} groups={groups} />
            </div>
          );
        const title = rowTitle(line.row);
        return (
          <div
            key={line.row.page.id}
            role="listitem"
            className="absolute inset-x-0 flex items-center border-b"
            style={{ top, height: ROW_HEIGHT }}
          >
            <button
              type="button"
              className="min-w-0 flex-1 truncate px-2 text-start text-sm outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              onClick={() => onOpen(line.row.page.id)}
            >
              {title === "" ? "Untitled" : title}
            </button>
          </div>
        );
      })}
      {canResize ? (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize item names"
          className="absolute inset-y-0 -end-1 z-10 w-2 cursor-col-resize touch-none"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { startX: event.clientX, start: width, width };
          }}
          onPointerMove={move}
          onPointerUp={() => release(true)}
          onPointerCancel={() => release(false)}
        />
      ) : null}
    </div>
  );
});
