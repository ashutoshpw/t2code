import { useDroppable } from "@dnd-kit/core";
import { type GroupLabel, canonicalJson } from "@t2code/client-runtime/spaces";
import type { SpaceGroupBucket, SpaceGroupKey } from "@t2code/contracts/spaces";

import { cn } from "~/lib/utils";
import { OptionChip } from "../primitives/OptionChip";

function HiddenGroup({
  bucket,
  label,
  canShow,
  onShow,
}: {
  readonly bucket: SpaceGroupBucket;
  readonly label: GroupLabel;
  readonly canShow: boolean;
  readonly onShow: (key: SpaceGroupKey) => void;
}) {
  const id = canonicalJson(bucket.key);
  const { setNodeRef, isOver } = useDroppable({
    id: `drop:${id}`,
    data: { type: "column", key: bucket.key, hidden: true },
  });
  return (
    <li
      ref={setNodeRef}
      data-column-id={id}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-2 py-1.5",
        isOver && "ring-2 ring-ring/60",
      )}
    >
      {label.color === undefined ? (
        <span className="min-w-0 truncate text-sm">{label.text}</span>
      ) : (
        <OptionChip name={label.text} color={label.color} />
      )}
      <span className="text-xs text-muted-foreground">{bucket.count}</span>
      {canShow ? (
        <button
          type="button"
          aria-label={`Show ${label.text}`}
          className="ms-auto rounded-sm px-1.5 text-xs text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={() => onShow(bucket.key)}
        >
          Show
        </button>
      ) : null}
    </li>
  );
}

/** Groups the view hides; dropping a card on one still writes its value. */
export function HiddenGroups({
  buckets,
  labelOf,
  canShow,
  onShow,
}: {
  readonly buckets: ReadonlyArray<SpaceGroupBucket>;
  readonly labelOf: (bucket: SpaceGroupBucket) => GroupLabel;
  readonly canShow: boolean;
  readonly onShow: (key: SpaceGroupKey) => void;
}) {
  return (
    <aside aria-label="Hidden groups" className="w-48 shrink-0 space-y-1">
      <h3 className="px-2 pt-2 text-xs font-medium text-muted-foreground">Hidden groups</h3>
      <ul className="space-y-0.5">
        {buckets.map((bucket) => (
          <HiddenGroup
            key={canonicalJson(bucket.key)}
            bucket={bucket}
            label={labelOf(bucket)}
            canShow={canShow}
            onShow={onShow}
          />
        ))}
      </ul>
    </aside>
  );
}
