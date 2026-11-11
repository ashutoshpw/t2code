import { CheckIcon, TriangleAlertIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { computedInfoOf, knownComputedValue } from "@t2code/client-runtime/spaces";
import type {
  SpaceCellValue,
  SpaceKnownDatabaseProperty,
  SpaceRelatedPage,
} from "@t2code/contracts/spaces";

import { computedNumberConfig, formatDate, formatNumber } from "./format";
import { OptionChip } from "./OptionChip";
import { TextRuns } from "./TextRuns";

type ComputedKnown = Extract<SpaceKnownDatabaseProperty, { type: "formula" | "rollup" }>;
type ParsedValue = NonNullable<ReturnType<typeof knownComputedValue>>;

const PAGE_CHIP = "truncate rounded-sm bg-foreground/6 px-1.5 text-xs/5";

function Item({
  value,
  known,
  relatedPages,
  timeZone,
}: {
  readonly value: ParsedValue;
  readonly known: ComputedKnown;
  readonly relatedPages: Readonly<Record<string, SpaceRelatedPage>>;
  readonly timeZone: string;
}) {
  switch (value.type) {
    case "string":
      if (value.color !== undefined) return <OptionChip name={value.value} color={value.color} />;
      return value.runs === undefined ? <>{value.value}</> : <TextRuns runs={value.runs} />;
    case "number":
      return <>{formatNumber(value.value, computedNumberConfig(known))}</>;
    case "boolean":
      return <Check checked={value.value} />;
    case "date":
      return <>{formatDate(value.value, {}, timeZone)}</>;
    case "page":
      return <span className={PAGE_CHIP}>{relatedPages[value.value]?.title || "Untitled"}</span>;
    case "array": {
      const seen = new Map<string, number>();
      const last = value.value.length - 1;
      return (
        <>
          {value.value.map((entry, index) => {
            const item = knownComputedValue(entry);
            const base = JSON.stringify(entry);
            const occurrence = seen.get(base) ?? 0;
            seen.set(base, occurrence + 1);
            return item === undefined ? null : (
              <span key={`${base}#${occurrence}`} className="flex min-w-0 items-center">
                <Item value={item} known={known} relatedPages={relatedPages} timeZone={timeZone} />
                {index < last || value.truncated === true ? (
                  <span aria-hidden className="text-muted-foreground">
                    ,
                  </span>
                ) : null}
              </span>
            );
          })}
          {value.truncated === true ? <span className="text-muted-foreground">…</span> : null}
        </>
      );
    }
  }
}

function Check({ checked }: { readonly checked: boolean }) {
  return (
    <span
      role="img"
      aria-label={checked ? "Checked" : "Unchecked"}
      className={
        checked
          ? "inline-flex size-4 items-center justify-center rounded-sm bg-primary text-primary-foreground"
          : "inline-flex size-4 rounded-sm border border-foreground/30"
      }
    >
      {checked ? <CheckIcon className="size-3" /> : null}
    </span>
  );
}

/** Read-only value of a formula or rollup, by the type of the result. */
export function ComputedValue({
  known,
  value,
  relatedPages,
  timeZone,
}: {
  readonly known: ComputedKnown;
  readonly value: SpaceCellValue | undefined;
  readonly relatedPages: Readonly<Record<string, SpaceRelatedPage>>;
  readonly timeZone: string;
}) {
  const info = computedInfoOf(known);
  if (info?.error !== undefined)
    return (
      <Tooltip>
        <TooltipTrigger
          render={<span className="inline-flex items-center gap-1 text-muted-foreground/70" />}
        >
          <TriangleAlertIcon className="size-3" aria-hidden />
          Error
        </TooltipTrigger>
        <TooltipPopup>{info.error.message}</TooltipPopup>
      </Tooltip>
    );
  const parsed = knownComputedValue(value);
  if (parsed === undefined) {
    // A boolean result with no stored value is an unchecked box; anything else is just empty.
    return info?.resultType === "boolean" ? <Check checked={false} /> : null;
  }
  return <Item value={parsed} known={known} relatedPages={relatedPages} timeZone={timeZone} />;
}
