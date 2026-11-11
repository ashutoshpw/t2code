import { useDraggable } from "@dnd-kit/core";
import type { EnvironmentId } from "@t2code/contracts";
import { type CellTextContext, canonicalJson, rowTitle } from "@t2code/client-runtime/spaces";
import { memo } from "react";
import type {
  SpaceDatabaseRow,
  SpaceGroupKey,
  SpaceKnownDatabaseProperty,
  SpacePageId,
  SpaceRelatedPage,
} from "@t2code/contracts/spaces";

import { cn } from "~/lib/utils";
import { CardCover } from "../primitives/CardCover";
import { CellValue } from "../primitives/CellValue";
import { coverOf } from "../primitives/coverSource";
import { laneCellId } from "./boardLayout";

/** A visible non-title property a card shows when the row has a value for it. */
export interface CardLine {
  readonly id: string;
  readonly known: SpaceKnownDatabaseProperty | null;
}

const sameKnown = (a: CardLine["known"], b: CardLine["known"]) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.id === b.id &&
    a.type === b.type &&
    canonicalJson(a.config) === canonicalJson(b.config));

/** Columns are rebuilt on every view render; compare their content so memoized cards hold. */
export const sameLines = (a: ReadonlyArray<CardLine>, b: ReadonlyArray<CardLine>) =>
  a === b ||
  (a.length === b.length &&
    a.every((line, index) => line.id === b[index]!.id && sameKnown(line.known, b[index]!.known)));

export interface CardContent {
  readonly row: SpaceDatabaseRow;
  readonly lines: ReadonlyArray<CardLine>;
  readonly relatedPages: Readonly<Record<string, SpaceRelatedPage>>;
  readonly optionHint: CellTextContext["optionHint"];
  readonly timeZone: string;
  /** Property lines wrap to three lines instead of one. */
  readonly wrap?: boolean;
}

const sameContent = (a: CardContent, b: CardContent) =>
  a.row === b.row &&
  a.wrap === b.wrap &&
  a.relatedPages === b.relatedPages &&
  a.timeZone === b.timeZone &&
  sameLines(a.lines, b.lines);

/** The card face; the drag overlay renders the same thing. */
export const CardBody = memo(function CardBody({
  row,
  lines,
  relatedPages,
  optionHint,
  timeZone,
  wrap,
}: CardContent) {
  const title = rowTitle(row);
  return (
    <>
      <span
        className={cn(
          "block truncate text-sm font-medium",
          title === "" && "text-muted-foreground",
        )}
      >
        {title === "" ? "Untitled" : title}
      </span>
      {lines.map((line) =>
        row.cells[line.id] === undefined ? null : (
          <span key={line.id} className="block min-w-0 text-xs text-muted-foreground">
            <CellValue
              known={line.known}
              value={row.cells[line.id]}
              relatedPages={relatedPages}
              variant="card"
              optionHint={optionHint}
              timeZone={timeZone}
              {...(wrap === true ? { wrap: true } : {})}
            />
          </span>
        ),
      )}
    </>
  );
}, sameContent);

export const CARD_FACE =
  "block w-full space-y-1 rounded-md border bg-background px-2.5 py-2 text-start shadow-xs/5";

interface BoardCardProps extends CardContent {
  readonly group: SpaceGroupKey;
  /** The sub-group lane the card sits in, when the board has lanes. */
  readonly lane?: SpaceGroupKey | undefined;
  readonly coverPropertyId: string | null;
  readonly coverContent: boolean;
  readonly coverHeight: number;
  readonly coverFit: boolean;
  readonly environmentId: EnvironmentId;
  readonly intrinsicHeight: number;
  readonly draggable: boolean;
  readonly onOpen: (pageId: SpacePageId) => void;
}

/** One card: a button that opens the row, and a drag source when the board can write the group. */
export const BoardCard = memo(
  function BoardCard({
    group,
    lane,
    draggable,
    onOpen,
    coverPropertyId,
    coverContent,
    coverHeight,
    coverFit,
    environmentId,
    intrinsicHeight,
    ...content
  }: BoardCardProps) {
    const pageId = content.row.page.id;
    const { setNodeRef, setActivatorNodeRef, attributes, listeners, isDragging } = useDraggable({
      id: `card:${laneCellId(lane, group)}:${pageId}`,
      data: { type: "card", pageId, group, lane },
      disabled: !draggable,
    });
    const hasCover = coverPropertyId !== null || coverContent;
    return (
      <div
        ref={setNodeRef}
        role="listitem"
        data-card-id={pageId}
        className="relative rounded-md data-drop-after:after:absolute data-drop-after:after:inset-x-0 data-drop-after:after:bottom-0 data-drop-after:after:z-10 data-drop-after:after:h-0.5 data-drop-after:after:rounded-full data-drop-after:after:bg-ring data-drop-before:before:absolute data-drop-before:before:inset-x-0 data-drop-before:before:top-0 data-drop-before:before:z-10 data-drop-before:before:h-0.5 data-drop-before:before:rounded-full data-drop-before:before:bg-ring"
        // Offscreen cards skip layout and paint; the intrinsic size keeps the scroll height stable.
        // Paint containment clips anything outside the box, so the drop lines sit inside it.
        style={{ contentVisibility: "auto", containIntrinsicSize: `auto ${intrinsicHeight}px` }}
      >
        <button
          ref={setActivatorNodeRef}
          type="button"
          {...(draggable ? attributes : {})}
          {...(draggable ? listeners : {})}
          onClick={() => onOpen(pageId)}
          className={cn(
            CARD_FACE,
            "cursor-pointer outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            isDragging && "opacity-40",
          )}
        >
          {hasCover ? (
            <span className="-mx-2.5 -mt-2 mb-1 block overflow-hidden rounded-t-md">
              <CardCover
                cover={coverOf(
                  content.row,
                  coverPropertyId !== null
                    ? { kind: "property", propertyId: coverPropertyId as never }
                    : { kind: "page_content" },
                )}
                fit={coverFit}
                height={coverHeight}
                environmentId={environmentId}
              />
            </span>
          ) : null}
          <CardBody {...content} />
        </button>
      </div>
    );
  },
  (prev, next) =>
    prev.draggable === next.draggable &&
    prev.onOpen === next.onOpen &&
    prev.coverPropertyId === next.coverPropertyId &&
    prev.coverContent === next.coverContent &&
    prev.coverHeight === next.coverHeight &&
    prev.coverFit === next.coverFit &&
    prev.intrinsicHeight === next.intrinsicHeight &&
    (prev.lane === next.lane ||
      (prev.lane !== undefined &&
        next.lane !== undefined &&
        canonicalJson(prev.lane) === canonicalJson(next.lane))) &&
    (prev.group === next.group || canonicalJson(prev.group) === canonicalJson(next.group)) &&
    sameContent(prev, next),
);
