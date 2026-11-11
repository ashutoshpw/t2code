import { type GroupLabel, serialDay } from "@t2code/client-runtime/spaces";
import { useState, type CSSProperties, type UIEvent } from "react";
import type { SpaceGroupBucket } from "@t2code/contracts/spaces";

import { observeResize } from "~/lib/observeResize";
import { rowTitle } from "@t2code/client-runtime/spaces";
import { TimelineBar, type TimelineHandlers } from "./TimelineBar";
import { TimelineLineLabel } from "./TimelineLineLabel";
import { TimelineSide } from "./TimelineSide";
import type { TimelineGroupHandlers, TimelineLine } from "./timelineLines";
import { barSpan, type BarSpan } from "./timelineDrag";
import {
  HEADER_TIER_HEIGHT,
  ROW_HEIGHT,
  dayToX,
  rowWindow,
  serialToX,
  snapMinutes,
  ticks,
  xToDay,
  type Scale,
} from "./timelineScale";

const HEADER_HEIGHT = HEADER_TIER_HEIGHT * 2;
/** Header ticks are rebuilt when the visible x range crosses one of these steps. */
const TICK_STEP_PX = 240;
const TICK_OVERSCAN_PX = 240;
const INITIAL_SIZE = { w: 960, h: 560 };

export interface TimelineCanvasProps {
  readonly scale: Scale;
  readonly anchorDay: string;
  readonly today: string;
  readonly lines: ReadonlyArray<TimelineLine>;
  readonly labelOf: (bucket: SpaceGroupBucket) => GroupLabel;
  readonly groups: TimelineGroupHandlers;
  readonly startPropertyId: string;
  readonly endPropertyId: string | null;
  readonly zone: string;
  readonly showTable: boolean;
  readonly tableWidth: number;
  readonly canResizeTable: boolean;
  readonly draggable: boolean;
  readonly handlers: TimelineHandlers;
  readonly hasMore: boolean;
  readonly onTableWidth: (width: number) => void;
  readonly loadMore: () => void;
  readonly busy: boolean;
}

interface Win {
  readonly x0: number;
  readonly x1: number;
  readonly first: number;
  readonly last: number;
}

/** Scroll offsets are kept in coarse steps: state, and with it a render, changes only across a step. */
const SCROLL_STEP_X = TICK_STEP_PX;
const SCROLL_STEP_Y = ROW_HEIGHT * 3;
const stepped = (value: number, step: number) => Math.floor(Math.max(0, value) / step) * step;

const windowOf = (
  scroll: { left: number; top: number },
  size: { w: number; h: number },
  count: number,
  scale: Scale,
): Win => {
  const x0 = Math.max(0, scroll.left - TICK_OVERSCAN_PX);
  const x1 = Math.min(scale.width, scroll.left + size.w + SCROLL_STEP_X + TICK_OVERSCAN_PX);
  const rows = rowWindow(count, scroll.top, Math.max(0, size.h - HEADER_HEIGHT) + SCROLL_STEP_Y);
  return { x0, x1, first: rows.first, last: rows.last };
};

/** The scroller: sticky two-tier header and table pane, bars windowed on both axes. */
export function TimelineCanvas(props: TimelineCanvasProps) {
  const { scale, lines, handlers } = props;
  const [size, setSize] = useState(INITIAL_SIZE);
  const [scroll, setScroll] = useState({ left: 0, top: 0 });
  const tableWidth = props.showTable ? props.tableWidth : 0;
  const [attach] = useState(() => (node: HTMLDivElement | null) => {
    if (node === null) return;
    const measure = () => {
      setSize((previous) =>
        previous.w === node.clientWidth && previous.h === node.clientHeight
          ? previous
          : { w: node.clientWidth, h: node.clientHeight },
      );
    };
    measure();
    // Open on the anchor day, a third in from the left.
    node.scrollLeft = Math.max(0, dayToX(scale, props.anchorDay) - node.clientWidth / 3);
    setScroll({ left: stepped(node.scrollLeft, SCROLL_STEP_X), top: 0 });
    return observeResize(node, measure);
  });
  const shown = windowOf(scroll, size, lines.length, scale);

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const left = stepped(event.currentTarget.scrollLeft, SCROLL_STEP_X);
    const top = stepped(event.currentTarget.scrollTop, SCROLL_STEP_Y);
    setScroll((previous) =>
      previous.left === left && previous.top === top ? previous : { left, top },
    );
  };

  const top = ticks(scale, "top", shown.x0, shown.x1);
  const bottom = ticks(scale, "bottom", shown.x0, shown.x1);
  const todayX = dayToX(scale, props.today);
  const spans = new Map<string, BarSpan | null>();
  const last = Math.min(lines.length, shown.last);
  for (let index = shown.first; index < last; index++) {
    const line = lines[index]!;
    if (line.kind !== "row") continue;
    const row = line.row;
    spans.set(
      row.page.id,
      barSpan(
        row.cells[props.startPropertyId],
        props.endPropertyId === null ? undefined : row.cells[props.endPropertyId],
        props.endPropertyId !== null,
        props.zone,
      ),
    );
  }
  const bodyHeight = lines.length * ROW_HEIGHT;
  const sideStyle: CSSProperties = { width: tableWidth };

  return (
    <div
      ref={attach}
      onScroll={onScroll}
      aria-busy={props.busy}
      className="relative h-[min(70vh,560px)] min-h-48 overflow-auto overscroll-contain rounded-lg border"
    >
      <div style={{ width: tableWidth + scale.width }} className="relative">
        <div
          className="sticky top-0 z-20 flex border-b bg-background"
          style={{ height: HEADER_HEIGHT }}
        >
          {props.showTable ? (
            <div
              style={sideStyle}
              className="sticky left-0 z-10 shrink-0 border-e bg-background px-2 py-1 text-xs text-muted-foreground"
            >
              Name
            </div>
          ) : null}
          <div className="relative shrink-0" style={{ width: scale.width }} aria-hidden>
            {top.map((tick) => (
              <div
                key={tick.key}
                className="absolute top-0 truncate border-s px-1 text-xs leading-6 text-muted-foreground"
                style={{ left: tick.x, width: tick.width, height: HEADER_TIER_HEIGHT }}
              >
                {tick.label}
              </div>
            ))}
            {bottom.map((tick) => (
              <div
                key={tick.key}
                className="absolute truncate border-s px-1 text-2xs leading-6 text-muted-foreground"
                style={{
                  left: tick.x,
                  width: tick.width,
                  top: HEADER_TIER_HEIGHT,
                  height: HEADER_TIER_HEIGHT,
                }}
              >
                {tick.label}
              </div>
            ))}
          </div>
        </div>
        <div className="flex" style={{ height: bodyHeight }}>
          {props.showTable ? (
            <TimelineSide
              lines={lines}
              labelOf={props.labelOf}
              groups={props.groups}
              first={shown.first}
              last={last}
              width={tableWidth}
              canResize={props.canResizeTable}
              onOpen={handlers.open}
              onWidth={props.onTableWidth}
            />
          ) : null}
          <div
            role="list"
            className="relative shrink-0"
            style={{ width: scale.width, height: bodyHeight }}
          >
            {todayX >= 0 && todayX <= scale.width ? (
              <div
                aria-hidden
                data-today
                className="pointer-events-none absolute inset-y-0 z-[1] w-px bg-destructive/60"
                style={{ left: todayX }}
              />
            ) : null}
            {lines.slice(shown.first, last).map((line, offset) => {
              const index = shown.first + offset;
              if (line.kind !== "row")
                return (
                  <div
                    key={line.kind === "group" ? line.id : `more:${JSON.stringify(line.group)}`}
                    role="presentation"
                    className="absolute inset-x-0 border-b bg-muted/30"
                    style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
                  >
                    {props.showTable ? null : (
                      <div className="sticky left-0 h-full" style={{ width: size.w }}>
                        <TimelineLineLabel
                          line={line}
                          labelOf={props.labelOf}
                          groups={props.groups}
                        />
                      </div>
                    )}
                  </div>
                );
              const row = line.row;
              const span = spans.get(row.page.id) ?? null;
              const title = rowTitle(row);
              const x0 = span === null ? 0 : serialToX(scale, span.start);
              const x1 = span === null ? 0 : serialToX(scale, span.end);
              const visible = span !== null && x1 >= 0 && x0 <= scale.width;
              const clipped = visible && (x0 < 0 || x1 > scale.width);
              return (
                <div
                  key={row.page.id}
                  role="listitem"
                  data-row-id={row.page.id}
                  className="absolute inset-x-0 border-b"
                  style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
                >
                  {span === null ? (
                    <button
                      type="button"
                      aria-label={`Set dates for ${title || "Untitled"}`}
                      disabled={!props.draggable}
                      className="absolute inset-0 cursor-cell outline-none hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent"
                      onClick={(event) => {
                        const box = event.currentTarget.getBoundingClientRect();
                        handlers.setDates(row.page.id, xToDay(scale, event.clientX - box.left));
                      }}
                    />
                  ) : visible ? (
                    <TimelineBar
                      pageId={row.page.id}
                      title={title}
                      left={Math.max(0, x0)}
                      width={Math.min(scale.width, x1) - Math.max(0, x0)}
                      startDay={serialDay(span.start)}
                      endDay={serialDay(Math.max(span.start, span.end - (span.timed ? 0 : 1)))}
                      scale={scale}
                      snap={snapMinutes(scale.zoom, span.timed)}
                      keyStep={snapMinutes(scale.zoom, span.timed)}
                      draggable={props.draggable && !clipped}
                      handlers={handlers}
                    />
                  ) : null}
                </div>
              );
            })}
            {props.hasMore && last >= lines.length ? (
              <div
                key={lines.length}
                aria-hidden
                className="absolute inset-x-0"
                style={{ top: bodyHeight - 1, height: 1 }}
                ref={(node) => {
                  if (node !== null) props.loadMore();
                }}
              />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
