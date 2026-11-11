import { rowTitle } from "@t2code/client-runtime/spaces";
import { PlusIcon } from "lucide-react";
import { memo } from "react";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceCardPreview, SpacePageId } from "@t2code/contracts/spaces";

import { Skeleton } from "~/components/ui/skeleton";
import { sameLines, CardBody, type CardContent } from "../board/BoardCard";
import { RowMenu } from "../list/RowMenu";
import type { RowListHandlers } from "../list/useRowList";
import { CardCover } from "../primitives/CardCover";
import { coverOf } from "../primitives/coverSource";

interface GalleryCardProps extends CardContent {
  readonly preview: SpaceCardPreview | undefined;
  readonly coverHeight: number;
  readonly fit: boolean;
  readonly environmentId: EnvironmentId;
  readonly spaceId: string;
  readonly handlers: RowListHandlers;
  readonly canTrash: boolean;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
}

const sameProps = (a: GalleryCardProps, b: GalleryCardProps) =>
  a.row === b.row &&
  a.relatedPages === b.relatedPages &&
  a.timeZone === b.timeZone &&
  a.preview === b.preview &&
  a.coverHeight === b.coverHeight &&
  a.fit === b.fit &&
  a.handlers === b.handlers &&
  a.environmentId === b.environmentId &&
  a.canTrash === b.canTrash &&
  a.canMoveUp === b.canMoveUp &&
  a.canMoveDown === b.canMoveDown &&
  sameLines(a.lines, b.lines);

const FACE =
  "flex h-full w-full flex-col overflow-hidden rounded-md border bg-background text-start shadow-xs/5 outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

/** A fixed-height card: cover, title and the visible properties; the row menu sits over the corner. */
export const GalleryCard = memo(function GalleryCard({
  row,
  lines,
  relatedPages,
  optionHint,
  timeZone,
  preview,
  coverHeight,
  fit,
  environmentId,
  spaceId,
  handlers,
  canTrash,
  canMoveUp,
  canMoveDown,
}: GalleryCardProps) {
  const pageId: SpacePageId = row.page.id;
  return (
    <div role="listitem" data-card-id={pageId} className="group/row relative h-full min-w-0">
      <button type="button" data-nav="" className={FACE} onClick={() => handlers.open(pageId)}>
        {coverHeight > 0 ? (
          <CardCover
            cover={coverOf(row, preview)}
            fit={fit}
            height={coverHeight}
            environmentId={environmentId}
          />
        ) : null}
        <span className="block min-h-0 w-full flex-1 space-y-1 overflow-hidden px-2.5 py-2">
          <CardBody
            row={row}
            lines={lines}
            relatedPages={relatedPages}
            optionHint={optionHint}
            timeZone={timeZone}
          />
        </span>
      </button>
      <RowMenu
        pageId={pageId}
        title={rowTitle(row)}
        spaceId={spaceId}
        environmentId={environmentId}
        handlers={handlers}
        canTrash={canTrash}
        canMoveUp={canMoveUp}
        canMoveDown={canMoveDown}
        className="absolute end-1.5 top-1.5 z-10"
      />
    </div>
  );
}, sameProps);

export function AddCard({
  adding,
  onAdd,
}: {
  readonly adding: boolean;
  readonly onAdd: () => void;
}) {
  return (
    <div role="listitem" className="h-full min-w-0">
      {adding ? (
        <Skeleton className="size-full" />
      ) : (
        <button
          type="button"
          data-nav=""
          className="flex size-full items-center justify-center gap-1 rounded-md border border-dashed text-sm text-muted-foreground outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={onAdd}
        >
          <PlusIcon className="size-3.5" />
          New
        </button>
      )}
    </div>
  );
}

export function SkeletonCard() {
  return (
    <div role="presentation" className="h-full min-w-0">
      <Skeleton className="size-full" />
    </div>
  );
}
