import { memo, useRef, type KeyboardEvent, type PointerEvent } from "react";
import type { SpacePageId } from "@t2code/contracts/spaces";

import { cn } from "~/lib/utils";
import { barWriteLabel } from "./barLabel";
import type { BarMode } from "./timelineDrag";
import { deltaToMinutes, type Scale } from "./timelineScale";

export interface TimelineHandlers {
  open(pageId: SpacePageId): void;
  /** Writes the bar's cells after a drag or a key press; resolves once they are sent when `flush`. */
  move(pageId: SpacePageId, mode: BarMode, minutes: number, flush: boolean): Promise<void>;
  hold(): () => void;
  setDates(pageId: SpacePageId, day: string): void;
}

const DRAG_THRESHOLD_PX = 3;
const MIN_BAR_PX = 4;

export interface TimelineBarProps {
  readonly pageId: SpacePageId;
  readonly title: string;
  readonly left: number;
  readonly width: number;
  readonly startDay: string;
  readonly endDay: string;
  readonly scale: Scale;
  readonly snap: number;
  readonly keyStep: number;
  readonly draggable: boolean;
  readonly handlers: TimelineHandlers;
}

interface DragState {
  readonly mode: BarMode;
  readonly startX: number;
  readonly release: () => void;
  minutes: number;
  moved: boolean;
}

const EDGE = "absolute inset-y-0 z-[1] w-1.5 cursor-ew-resize touch-none";

/** One bar. During a drag only its inline style changes; the write happens once on release. */
export const TimelineBar = memo(function TimelineBar({
  pageId,
  title,
  left,
  width,
  startDay,
  endDay,
  scale,
  snap,
  keyStep,
  draggable,
  handlers,
}: TimelineBarProps) {
  const element = useRef<HTMLButtonElement>(null);
  const drag = useRef<DragState | null>(null);
  const suppressClick = useRef(false);
  const drawn = Math.max(MIN_BAR_PX, width);

  const reset = (node: HTMLButtonElement | null) => {
    if (node === null) return;
    node.style.transform = "";
    node.style.width = `${drawn}px`;
  };
  // A committed render replaces the drag's inline style with the new geometry; mid-drag renders keep it.
  const attach = (node: HTMLButtonElement | null) => {
    element.current = node;
    if (drag.current === null) reset(node);
  };
  const show = (state: DragState) => {
    const node = element.current;
    if (node === null) return;
    const px = (state.minutes / 1440) * scale.pxPerDay;
    if (state.mode === "move") node.style.transform = `translateX(${px}px)`;
    else if (state.mode === "start") {
      node.style.transform = `translateX(${px}px)`;
      node.style.width = `${Math.max(MIN_BAR_PX, drawn - px)}px`;
    } else node.style.width = `${Math.max(MIN_BAR_PX, drawn + px)}px`;
  };
  const end = (commit: boolean) => {
    const state = drag.current;
    drag.current = null;
    if (state === null) return;
    suppressClick.current = state.moved;
    if (commit && state.minutes !== 0) {
      void handlers.move(pageId, state.mode, state.minutes, true).finally(() => {
        state.release();
        reset(element.current);
      });
      return;
    }
    reset(element.current);
    state.release();
  };

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (!draggable || event.button !== 0 || drag.current !== null) return;
    const edge = (event.target as HTMLElement).dataset.edge;
    const mode: BarMode = edge === "start" || edge === "end" ? edge : "move";
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      mode,
      startX: event.clientX,
      release: handlers.hold(),
      minutes: 0,
      moved: false,
    };
  };
  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const state = drag.current;
    if (state === null) return;
    const dx = event.clientX - state.startX;
    if (!state.moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
    state.moved = true;
    const minutes = deltaToMinutes(scale, dx, snap);
    if (minutes === state.minutes) return;
    state.minutes = minutes;
    show(state);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape" && drag.current !== null) {
      event.preventDefault();
      end(false);
      return;
    }
    if (!draggable || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    event.preventDefault();
    const mode: BarMode = event.shiftKey ? "end" : event.altKey ? "start" : "move";
    void handlers.move(pageId, mode, event.key === "ArrowLeft" ? -keyStep : keyStep, false);
  };

  return (
    <button
      ref={attach}
      type="button"
      data-bar-id={pageId}
      aria-label={barWriteLabel(title, startDay, endDay)}
      style={{ left, width: drawn }}
      className={cn(
        "absolute top-1.5 h-6 touch-none truncate rounded-md border bg-primary/15 px-1.5 text-start text-xs outline-none hover:bg-primary/25 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        draggable && "cursor-grab active:cursor-grabbing",
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => end(true)}
      onPointerCancel={() => end(false)}
      onKeyDown={onKeyDown}
      onClick={() => {
        if (suppressClick.current) {
          suppressClick.current = false;
          return;
        }
        handlers.open(pageId);
      }}
    >
      {draggable ? (
        <>
          <span data-edge="start" aria-hidden className={cn(EDGE, "start-0")} />
          <span data-edge="end" aria-hidden className={cn(EDGE, "end-0")} />
        </>
      ) : null}
      <span className="pointer-events-none">{title || "Untitled"}</span>
    </button>
  );
});
