import { CheckIcon } from "lucide-react";
import { memo } from "react";
import type {
  SpaceCellValue,
  SpaceDateValue,
  SpaceKnownDatabaseProperty,
  SpaceRelatedPage,
} from "@t2code/contracts/spaces";

import { cn } from "~/lib/utils";
import { cellPlainText, formatNumber, optionLabel, type CellTextContext } from "./format";
import { OptionChip } from "./OptionChip";
import { TextRuns } from "./TextRuns";
import { ComputedValue } from "./ComputedValue";

export type CellValueVariant = "cell" | "card" | "field";

interface CellValueProps {
  readonly known: SpaceKnownDatabaseProperty | null;
  readonly value: SpaceCellValue | undefined;
  readonly relatedPages: Readonly<Record<string, SpaceRelatedPage>>;
  readonly variant: CellValueVariant;
  readonly optionHint: CellTextContext["optionHint"];
  readonly timeZone: string;
  /** Up to three lines instead of one; the table sets it for wrapped columns. */
  readonly wrap?: boolean;
}

const muted = (text: string) => <span className="text-muted-foreground/70">{text}</span>;

function Chips({
  known,
  ids,
  optionHint,
}: {
  readonly known: Extract<
    SpaceKnownDatabaseProperty,
    { type: "select" | "multi_select" | "status" }
  >;
  readonly ids: ReadonlyArray<unknown>;
  readonly optionHint: CellTextContext["optionHint"];
}) {
  return ids.map((id) => {
    if (typeof id !== "string") return null;
    const option = known.config.options.find((entry) => entry.id === id);
    const hint = option === undefined ? optionHint(known.id, id) : undefined;
    const name = option?.name ?? optionLabel(known, id, optionHint);
    return name === undefined ? null : (
      <OptionChip key={id} name={name} color={option?.color ?? hint?.color ?? "default"} />
    );
  });
}

function NumberValue({
  known,
  value,
}: {
  readonly known: Extract<SpaceKnownDatabaseProperty, { type: "number" }>;
  readonly value: number;
}) {
  const showAs = known.config.showAs;
  const text = formatNumber(value, known.config);
  if (showAs === undefined || showAs.kind === "number") return <>{text}</>;
  const fraction = Math.max(0, Math.min(1, value / (showAs.divideBy ?? 100)));
  const percent = Math.round(fraction * 100);
  return (
    <span className="flex min-w-0 items-center gap-2">
      {showAs.showNumber === false ? null : <span className="shrink-0">{text}</span>}
      {showAs.kind === "bar" ? (
        <span aria-hidden className="h-1.5 min-w-8 flex-1 rounded-full bg-foreground/10">
          <span className="block h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
        </span>
      ) : (
        <span
          aria-hidden
          className="size-4 shrink-0 rounded-full bg-foreground/10"
          style={{
            backgroundImage: `conic-gradient(var(--color-primary) ${percent}%, transparent 0)`,
          }}
        />
      )}
    </span>
  );
}

function Content({ known, value, relatedPages, optionHint, timeZone }: CellValueProps) {
  if (known === null) return muted("Unsupported");
  if (known.type === "formula" || known.type === "rollup")
    return (
      <ComputedValue known={known} value={value} relatedPages={relatedPages} timeZone={timeZone} />
    );
  if (value === undefined || value === null) return null;
  switch (known.type) {
    case "title":
      return <>{typeof value === "string" ? value : ""}</>;
    case "text":
      return Array.isArray(value) ? <TextRuns runs={value} /> : null;
    case "number":
      return typeof value === "number" ? <NumberValue known={known} value={value} /> : null;
    case "select":
    case "status":
      return typeof value === "string" ? (
        <Chips known={known} ids={[value]} optionHint={optionHint} />
      ) : null;
    case "multi_select":
      return Array.isArray(value) ? (
        <Chips known={known} ids={value} optionHint={optionHint} />
      ) : null;
    case "checkbox":
      return value === true ? (
        <span
          role="img"
          aria-label="Checked"
          className="inline-flex size-4 items-center justify-center rounded-sm bg-primary text-primary-foreground"
        >
          <CheckIcon className="size-3" />
        </span>
      ) : null;
    case "relation":
      return Array.isArray(value)
        ? value.map((id) => {
            const page = typeof id === "string" ? relatedPages[id] : undefined;
            return page === undefined ? null : (
              <span
                key={String(id)}
                className="truncate rounded-sm bg-foreground/6 px-1.5 text-xs/5"
              >
                {page.title || "Untitled"}
              </span>
            );
          })
        : null;
    case "files":
      return Array.isArray(value)
        ? value.map((item) =>
            typeof item === "object" && item !== null && "name" in item ? (
              <span
                key={`${String(item.name)}:${"url" in item ? String(item.url) : ""}`}
                className="truncate rounded-sm bg-foreground/6 px-1.5 text-xs/5"
              >
                {String(item.name)}
              </span>
            ) : null,
          )
        : null;
    case "date":
    case "created_time":
    case "last_edited_time":
    case "unique_id":
    case "url":
    case "email":
    case "phone":
      return (
        <>
          {cellPlainText(value as SpaceCellValue | SpaceDateValue, known, {
            relatedPages,
            optionHint,
            timeZone,
          })}
        </>
      );
  }
}

/** Read-only renderer of every property type: one truncated line in each variant. */
export const CellValue = memo(function CellValue(props: CellValueProps) {
  return (
    <span
      data-variant={props.variant}
      className={cn(
        "flex min-w-0 gap-1 overflow-hidden",
        props.wrap === true
          ? "max-h-[3.75rem] flex-wrap items-start whitespace-normal break-words"
          : "items-center whitespace-nowrap",
        props.variant === "card" && "text-xs text-muted-foreground",
      )}
    >
      <Content {...props} />
    </span>
  );
});
