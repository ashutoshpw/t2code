import {
  childrenOf,
  connectiveOf,
  defaultCondition,
  filterOperatorsFor,
  insertAt,
  isFilterGroup,
  knownProperty,
  nodeAt,
  removeAt,
  setAt,
  setConnective,
  wrapInGroup,
  type FilterCondition,
  type FilterConnective,
  type FilterGroupNode,
  type FilterPath,
} from "@t2code/client-runtime/spaces";
import type { SpaceDatabaseProperty } from "@t2code/contracts/spaces";
import { PlusIcon, Trash2Icon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { FilterRule } from "./FilterRule";
import { OptionSelect } from "./OptionSelect";

export interface FilterContext {
  readonly properties: Readonly<Record<string, SpaceDatabaseProperty>>;
  readonly disabled: boolean;
  readonly maxDepth: number;
  readonly atConditionLimit: boolean;
  readonly commit: (root: FilterGroupNode) => void;
}

const CONNECTIVES = [
  { value: "and", label: "And" },
  { value: "or", label: "Or" },
] as const;

/** The first property a new rule can start on: the title, else the first filterable one. */
function startingCondition(properties: FilterContext["properties"]): FilterCondition | null {
  const candidates = Object.values(properties)
    .filter((property) => filterOperatorsFor(property.type).length > 0)
    .sort((a, b) => a.position - b.position);
  for (const candidate of candidates) {
    const known = knownProperty(candidate);
    if (known !== null) return defaultCondition(known);
  }
  return null;
}

function Lead({
  index,
  connective,
  disabled,
  onConnective,
}: {
  readonly index: number;
  readonly connective: FilterConnective;
  readonly disabled: boolean;
  readonly onConnective: (next: FilterConnective) => void;
}) {
  if (index === 0)
    return <span className="w-14 shrink-0 text-xs text-muted-foreground">Where</span>;
  if (index === 1)
    return (
      <div className="w-14 shrink-0">
        <OptionSelect
          label="Connective"
          value={connective}
          choices={CONNECTIVES}
          disabled={disabled}
          onChange={onConnective}
        />
      </div>
    );
  return (
    <span className="w-14 shrink-0 text-xs text-muted-foreground">
      {connective === "and" ? "And" : "Or"}
    </span>
  );
}

export function FilterGroup({
  root,
  path,
  context,
}: {
  readonly root: FilterGroupNode;
  readonly path: FilterPath;
  readonly context: FilterContext;
}) {
  const group = nodeAt(root, path);
  if (group === undefined || !isFilterGroup(group)) return null;
  const { disabled, commit } = context;
  const connective = connectiveOf(group);
  const children = childrenOf(group);
  const starting = startingCondition(context.properties);
  const canAddRule = !disabled && !context.atConditionLimit && starting !== null;
  // The new group holds one rule, so it is two groups deeper than this one's path.
  const canAddGroup = canAddRule && path.length + 2 <= context.maxDepth;
  return (
    <div className="space-y-1.5">
      {children.map((child, index) => {
        const childPath = [...path, index];
        const lead = (
          <Lead
            index={index}
            connective={connective}
            disabled={disabled}
            onConnective={(next) => commit(setConnective(root, path, next))}
          />
        );
        if (isFilterGroup(child))
          return (
            <div key={childPath.join(".")} className="flex items-start gap-1.5">
              {lead}
              <div
                role="group"
                aria-label="Filter group"
                className="min-w-0 flex-1 space-y-1.5 rounded-md border bg-muted/30 p-1.5"
              >
                <FilterGroup root={root} path={childPath} context={context} />
                <Button
                  variant="ghost-muted"
                  size="xs"
                  disabled={disabled}
                  onClick={() => commit(removeAt(root, childPath))}
                >
                  <Trash2Icon />
                  Remove group
                </Button>
              </div>
            </div>
          );
        return (
          <div key={childPath.join(".")} className="flex items-start gap-1.5">
            {lead}
            <FilterRule
              condition={child}
              properties={context.properties}
              disabled={disabled}
              canGroup={path.length + 2 <= context.maxDepth}
              onChange={(next) => commit(setAt(root, childPath, next))}
              onDuplicate={() => commit(insertAt(root, path, child, index + 1))}
              onWrap={() => commit(wrapInGroup(root, childPath))}
              onRemove={() => commit(removeAt(root, childPath))}
            />
          </div>
        );
      })}
      <div className="flex items-center gap-1">
        <Button
          variant="ghost-muted"
          size="xs"
          disabled={!canAddRule}
          onClick={() => starting !== null && commit(insertAt(root, path, starting))}
        >
          <PlusIcon />
          Add rule
        </Button>
        {path.length + 2 <= context.maxDepth ? (
          <Button
            variant="ghost-muted"
            size="xs"
            disabled={!canAddGroup}
            onClick={() => starting !== null && commit(insertAt(root, path, { and: [starting] }))}
          >
            <PlusIcon />
            Add group
          </Button>
        ) : null}
      </div>
    </div>
  );
}
