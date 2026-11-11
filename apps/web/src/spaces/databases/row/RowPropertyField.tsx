import { type CellTextContext, cellPlainText } from "@t2code/client-runtime/spaces";
import { CheckIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { EnvironmentId } from "@t2code/contracts";
import type {
  SpaceCellValue,
  SpaceDatabaseProperty,
  SpaceKnownDatabaseProperty,
  SpacePageId,
  SpaceRelatedPage,
} from "@t2code/contracts/spaces";

import { cn } from "~/lib/utils";
import { CellEditor, editorKind } from "../cells/CellEditor";
import { PropertyMenu } from "../controls/PropertyMenu";
import { CellValue } from "../primitives/CellValue";
import { PropertyTypeIcon } from "../primitives/PropertyTypeIcon";

export interface RowPropertyFieldProps {
  readonly pageId: SpacePageId;
  readonly property: SpaceDatabaseProperty;
  readonly known: SpaceKnownDatabaseProperty | null;
  readonly value: SpaceCellValue | undefined;
  readonly relatedPages: Readonly<Record<string, SpaceRelatedPage>>;
  readonly environmentId: EnvironmentId;
  readonly optionHint: CellTextContext["optionHint"];
  readonly timeZone: string;
  readonly editable: boolean;
  /** The schema may change: the name opens the property menu. */
  readonly canEditSchema: boolean;
  readonly editing: boolean;
  /** A closed editor hands focus back to the value. */
  readonly wantFocus: boolean;
  onFocused(): void;
  onEdit(): void;
  onToggle(): void;
  onCommit(value: SpaceCellValue | null, reason?: "blur"): void;
  onPicked?(pages: Readonly<Record<string, SpaceRelatedPage>>): void;
  onChange(value: SpaceCellValue | null): void;
  onClose(): void;
}

const nameClass =
  "flex h-8 min-w-0 items-center gap-1.5 rounded-sm px-1.5 text-left text-muted-foreground";

/** One property of a row page: its name on the left, its value (or its editor) on the right. */
export function RowPropertyField(props: RowPropertyFieldProps): ReactNode {
  const { property, known, value, editing, editable } = props;
  const kind = known === null ? "none" : editorKind(known.type);
  const interactive = editable && known !== null && kind !== "none";
  const text = known === null ? "" : cellPlainText(value, known, props);
  const name = (
    <span className={nameClass}>
      <PropertyTypeIcon type={property.type} />
      <span className="truncate">{property.name}</span>
    </span>
  );
  return (
    <div role="listitem" className="grid grid-cols-[9rem_minmax(0,1fr)] items-start gap-2">
      {props.canEditSchema ? (
        <PropertyMenu
          propertyId={property.id}
          render={
            <button
              type="button"
              aria-label={`${property.name} property menu`}
              className={cn(
                nameClass,
                "hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              )}
            />
          }
        />
      ) : (
        name
      )}
      <div className="relative min-h-8 min-w-0">
        {editing && known !== null && kind !== "toggle" ? (
          <>
            {kind === "popover" ? (
              <div className="flex min-h-8 items-center px-1.5">
                <CellValue
                  known={known}
                  value={value}
                  relatedPages={props.relatedPages}
                  variant="field"
                  optionHint={props.optionHint}
                  timeZone={props.timeZone}
                />
              </div>
            ) : null}
            <CellEditor
              known={known}
              value={value}
              pageId={props.pageId}
              variant="field"
              relatedPages={props.relatedPages}
              environmentId={props.environmentId}
              onCommit={(next, _move, reason) => props.onCommit(next, reason)}
              onChange={props.onChange}
              {...(props.onPicked === undefined ? {} : { onPicked: props.onPicked })}
              onClose={props.onClose}
            />
          </>
        ) : (
          <button
            type="button"
            data-row-field={property.id}
            role={kind === "toggle" ? "checkbox" : undefined}
            aria-checked={kind === "toggle" ? value === true : undefined}
            aria-readonly={interactive ? undefined : true}
            aria-label={
              kind === "toggle" || text === "" ? property.name : `${property.name}: ${text}`
            }
            ref={(element) => {
              if (element !== null && props.wantFocus) {
                element.focus({ preventScroll: true });
                props.onFocused();
              }
            }}
            className={cn(
              "flex min-h-8 w-full min-w-0 items-center rounded-sm px-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              interactive && "hover:bg-accent/60",
            )}
            onClick={() => {
              if (!interactive) return;
              if (kind === "toggle") props.onToggle();
              else props.onEdit();
            }}
          >
            {kind === "toggle" ? (
              <span
                className={cn(
                  "flex size-4 items-center justify-center rounded-sm border",
                  value === true && "border-primary bg-primary text-primary-foreground",
                )}
              >
                {value === true ? <CheckIcon className="size-3" /> : null}
              </span>
            ) : known === null ? (
              <span className="text-muted-foreground/70">Unsupported property</span>
            ) : text === "" &&
              known.type !== "formula" &&
              known.type !== "rollup" &&
              !(Array.isArray(value) && value.length > 0) ? (
              <span className="text-muted-foreground/60">Empty</span>
            ) : (
              <CellValue
                known={known}
                value={value}
                relatedPages={props.relatedPages}
                variant="field"
                optionHint={props.optionHint}
                timeZone={props.timeZone}
              />
            )}
          </button>
        )}
      </div>
    </div>
  );
}
