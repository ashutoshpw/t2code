import { knownQueryType } from "@t2code/client-runtime/spaces";
import {
  SPACE_AGGREGATES_BY_TYPE,
  type SpaceAggregateFunction,
  type SpaceAggregateResult,
} from "@t2code/contracts/spaces";
import type { SpacePropertyId } from "@t2code/contracts/spaces";

import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "~/components/ui/menu";
import { cn } from "~/lib/utils";
import { formatAggregate } from "../primitives/format";
import { useDatabaseActions } from "../shell/context";
import { widthValue } from "./columnResize";
import { FOOTER_HEIGHT } from "./gridWindow";
import type { TableColumn } from "./tableTypes";

const LABELS: Record<string, string> = {
  count: "Count all",
  count_values: "Count values",
  count_unique: "Count unique values",
  empty: "Count empty",
  not_empty: "Count not empty",
  percent_empty: "Percent empty",
  percent_not_empty: "Percent not empty",
  sum: "Sum",
  average: "Average",
  median: "Median",
  min: "Min",
  max: "Max",
  range: "Range",
  earliest: "Earliest date",
  latest: "Latest date",
  date_range: "Date range",
  checked: "Checked",
  unchecked: "Unchecked",
  percent_checked: "Percent checked",
  percent_unchecked: "Percent unchecked",
};

const aggregateLabel = (fn: string) => LABELS[fn] ?? fn;

const aggregatesFor = (type: string | undefined): ReadonlyArray<string> =>
  type !== undefined && Object.hasOwn(SPACE_AGGREGATES_BY_TYPE, type)
    ? SPACE_AGGREGATES_BY_TYPE[type as keyof typeof SPACE_AGGREGATES_BY_TYPE]
    : [];

const CELL =
  "flex h-full shrink-0 items-center border-e border-border/60 bg-background text-xs text-muted-foreground";
const TRIGGER =
  "flex h-full w-full items-center px-2 text-start outline-none after:text-muted-foreground after:opacity-0 hover:after:opacity-100 focus-visible:after:opacity-100 hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

function AggregateCell({
  column,
  aggregate,
  result,
  total,
  canEdit,
  timeZone,
}: {
  readonly column: TableColumn;
  readonly aggregate: string | undefined;
  readonly result: SpaceAggregateResult | undefined;
  readonly total: number | undefined;
  readonly canEdit: boolean;
  readonly timeZone: string;
}) {
  const actions = useDatabaseActions();
  const isTitle = column.id === "title";
  const options: ReadonlyArray<string> =
    column.known === null ? [] : aggregatesFor(knownQueryType(column.known));
  const text =
    aggregate === undefined
      ? isTitle && total !== undefined
        ? `Count ${total}`
        : null
      : result === undefined
        ? ""
        : `${aggregateLabel(aggregate)} ${formatAggregate(result, column.known, timeZone)}`.trim();
  return (
    <div
      role="gridcell"
      style={{ width: widthValue(column.id) }}
      className={cn(CELL, isTitle && "sticky start-0 z-[1]")}
    >
      {canEdit && options.length > 0 ? (
        <Menu>
          <MenuTrigger
            render={
              <button
                type="button"
                aria-label={`Calculate ${column.name}`}
                className={cn(TRIGGER, text === null && "after:content-['Calculate']")}
              />
            }
          >
            {text}
          </MenuTrigger>
          <MenuPopup align="start" side="top">
            <MenuRadioGroup
              value={aggregate ?? "none"}
              onValueChange={(next) =>
                actions.editView({
                  properties: {
                    set: {
                      [column.id as SpacePropertyId]: {
                        aggregate: next === "none" ? null : (next as SpaceAggregateFunction),
                      },
                    },
                  },
                })
              }
            >
              <MenuRadioItem value="none">None</MenuRadioItem>
              {options.map((fn) => (
                <MenuRadioItem key={fn} value={fn}>
                  {aggregateLabel(fn)}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuPopup>
        </Menu>
      ) : (
        <span className="px-2">{text}</span>
      )}
    </div>
  );
}

/** The footer: one calculation per column, pinned to the bottom of the scroller. */
export function AggregateRow({
  columns,
  aggregates,
  total,
  canEdit,
  timeZone,
  ariaRow,
  totalWidth,
  aggregateOf,
  group,
}: {
  readonly columns: ReadonlyArray<TableColumn>;
  readonly aggregates: ReadonlyArray<SpaceAggregateResult>;
  readonly total: number | undefined;
  readonly canEdit: boolean;
  readonly timeZone: string;
  readonly ariaRow: number;
  readonly totalWidth: number;
  readonly aggregateOf: (id: string) => string | undefined;
  /** A group's own line, placed in the rows instead of pinned to the bottom. */
  readonly group?: { readonly top: number };
}) {
  return (
    <div
      role="row"
      aria-rowindex={ariaRow}
      className={
        group === undefined
          ? "sticky bottom-0 z-[2] flex border-t bg-background"
          : "absolute start-0 flex border-b border-border/60 bg-muted/20"
      }
      style={{
        height: FOOTER_HEIGHT,
        width: totalWidth,
        ...(group === undefined ? {} : { top: group.top }),
      }}
    >
      {columns.map((column) => (
        <AggregateCell
          key={column.id}
          column={column}
          aggregate={aggregateOf(column.id)}
          result={aggregates.find((entry) => entry.property === column.id)}
          total={total}
          canEdit={canEdit}
          timeZone={timeZone}
        />
      ))}
    </div>
  );
}
