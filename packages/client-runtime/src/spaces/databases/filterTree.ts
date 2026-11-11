import {
  SPACE_FILTER_OPERATORS,
  measureSpaceFilter,
  type SpaceFilterShape,
  type SpaceKnownDatabaseProperty,
  type SpaceKnownFilter,
  type SpacePropertyId,
} from "@t2code/contracts/spaces";

import { propertyOptions } from "./schema.ts";

export type FilterCondition = Extract<SpaceKnownFilter, { readonly property: SpacePropertyId }>;
export type FilterGroupNode =
  | { readonly and: ReadonlyArray<SpaceKnownFilter> }
  | { readonly or: ReadonlyArray<SpaceKnownFilter> };
export type FilterConnective = "and" | "or";
/** Child indexes from the root group; the empty path is the root group itself. */
export type FilterPath = ReadonlyArray<number>;

export const isFilterGroup = (filter: SpaceKnownFilter): filter is FilterGroupNode =>
  "and" in filter || "or" in filter;

export const connectiveOf = (group: FilterGroupNode): FilterConnective =>
  "and" in group ? "and" : "or";
export const childrenOf = (group: FilterGroupNode): ReadonlyArray<SpaceKnownFilter> =>
  "and" in group ? group.and : group.or;
const makeGroup = (
  connective: FilterConnective,
  children: ReadonlyArray<SpaceKnownFilter>,
): FilterGroupNode => (connective === "and" ? { and: children } : { or: children });

/** The root is always edited as a group: a bare condition or nothing becomes an `and`. */
export function rootGroup(filter: SpaceKnownFilter | null | undefined): FilterGroupNode {
  if (filter === undefined || filter === null) return { and: [] };
  return isFilterGroup(filter) ? filter : { and: [filter] };
}

export function nodeAt(root: FilterGroupNode, path: FilterPath): SpaceKnownFilter | undefined {
  let node: SpaceKnownFilter = root;
  for (const index of path) {
    if (!isFilterGroup(node)) return undefined;
    const child: SpaceKnownFilter | undefined = childrenOf(node)[index];
    if (child === undefined) return undefined;
    node = child;
  }
  return node;
}

export function conditionAt(root: FilterGroupNode, path: FilterPath): FilterCondition | undefined {
  const node = nodeAt(root, path);
  return node === undefined || isFilterGroup(node) ? undefined : node;
}

function edit(
  node: SpaceKnownFilter,
  path: FilterPath,
  change: (target: SpaceKnownFilter) => SpaceKnownFilter | null,
): SpaceKnownFilter | null {
  const [head, ...rest] = path;
  if (head === undefined) return change(node);
  if (!isFilterGroup(node)) return node;
  const children = childrenOf(node);
  const target = children[head];
  if (target === undefined) return node;
  const replaced = edit(target, rest, change);
  const next =
    replaced === null
      ? children.filter((_, index) => index !== head)
      : children.map((child, index) => (index === head ? replaced : child));
  return makeGroup(connectiveOf(node), next);
}

/** Replaces the node at `path`; the empty path replaces the root and must be a group. */
export function setAt(root: FilterGroupNode, path: FilterPath, node: SpaceKnownFilter) {
  const next = edit(root, path, () => node);
  return next !== null && isFilterGroup(next) ? next : root;
}

export function removeAt(root: FilterGroupNode, path: FilterPath): FilterGroupNode {
  if (path.length === 0) return makeGroup(connectiveOf(root), []);
  const next = edit(root, path, () => null);
  return next !== null && isFilterGroup(next) ? next : root;
}

/** Inserts into the group at `groupPath`; `index` defaults to the end. */
export function insertAt(
  root: FilterGroupNode,
  groupPath: FilterPath,
  node: SpaceKnownFilter,
  index?: number,
): FilterGroupNode {
  const next = edit(root, groupPath, (target) => {
    if (!isFilterGroup(target)) return target;
    const children = [...childrenOf(target)];
    children.splice(index ?? children.length, 0, node);
    return makeGroup(connectiveOf(target), children);
  });
  return next !== null && isFilterGroup(next) ? next : root;
}

/** Turns the node at `path` into a one-child `and` group holding it. */
export function wrapInGroup(root: FilterGroupNode, path: FilterPath): FilterGroupNode {
  if (path.length === 0) return root;
  const next = edit(root, path, (target) => ({ and: [target] }));
  return next !== null && isFilterGroup(next) ? next : root;
}

export function setConnective(
  root: FilterGroupNode,
  groupPath: FilterPath,
  connective: FilterConnective,
): FilterGroupNode {
  const next = edit(root, groupPath, (target) =>
    isFilterGroup(target) ? makeGroup(connective, childrenOf(target)) : target,
  );
  return next !== null && isFilterGroup(next) ? next : root;
}

function pruned(filter: SpaceKnownFilter): SpaceKnownFilter | null {
  if (!isFilterGroup(filter)) return filter;
  const children = childrenOf(filter).flatMap((child) => {
    const kept = pruned(child);
    return kept === null ? [] : [kept];
  });
  return children.length === 0 ? null : makeGroup(connectiveOf(filter), children);
}

/** Drops empty groups; an empty root is no filter at all. */
export function prune(filter: SpaceKnownFilter | null | undefined): SpaceKnownFilter | null {
  return filter === undefined || filter === null ? null : pruned(filter);
}

/** Removes every condition on a property, for example after the property is deleted. */
export function withoutProperty(
  filter: SpaceKnownFilter | null | undefined,
  propertyId: SpacePropertyId,
): SpaceKnownFilter | null {
  if (filter === undefined || filter === null) return null;
  const strip = (node: SpaceKnownFilter): SpaceKnownFilter | null => {
    if (!isFilterGroup(node)) return node.property === propertyId ? null : node;
    const children = childrenOf(node).flatMap((child) => {
      const kept = strip(child);
      return kept === null ? [] : [kept];
    });
    return makeGroup(connectiveOf(node), children);
  };
  return prune(strip(filter));
}

export function filterShape(filter: SpaceKnownFilter | null | undefined): SpaceFilterShape {
  return filter === undefined || filter === null
    ? { depth: 0, conditions: 0 }
    : measureSpaceFilter(filter);
}

export const operatorNeedsValue = (operator: string): boolean =>
  operator !== "is_empty" && operator !== "is_not_empty";

export const filterOperatorsFor = (type: string): ReadonlyArray<string> =>
  Object.hasOwn(SPACE_FILTER_OPERATORS, type)
    ? SPACE_FILTER_OPERATORS[type as keyof typeof SPACE_FILTER_OPERATORS]
    : [];

/** What a freshly chosen operator carries when it needs a value; null when no legal value exists. */
function defaultValueFor(
  known: SpaceKnownDatabaseProperty,
  operator: string,
): { readonly value: unknown } | { readonly value?: undefined } | null {
  if (!operatorNeedsValue(operator)) return {};
  switch (known.type) {
    case "title":
    case "text":
    case "url":
    case "email":
    case "phone":
      return { value: "" };
    case "number":
    case "unique_id":
      return { value: 0 };
    case "checkbox":
      return { value: true };
    case "select":
    case "multi_select":
    case "status": {
      if (known.type === "status" && (operator === "in_group" || operator === "not_in_group"))
        return { value: "todo" };
      const first = propertyOptions(known)[0];
      return first === undefined ? null : { value: first.id };
    }
    case "date":
    case "created_time":
    case "last_edited_time":
      return operator === "within"
        ? { value: { direction: "past", unit: "week" } }
        : { value: { relative: "today" } };
    default:
      return null;
  }
}

/**
 * The first operator the type offers that can be given a value now. Relations only offer the
 * emptiness operators until a page picker exists; a select with no options starts at `is_empty`.
 */
export function defaultCondition(known: SpaceKnownDatabaseProperty): FilterCondition {
  const operators = filterOperatorsFor(known.type).filter(
    (operator) => known.type !== "relation" || !operatorNeedsValue(operator),
  );
  for (const operator of operators) {
    const value = defaultValueFor(known, operator);
    if (value !== null)
      return {
        property: known.id,
        operator: operator as FilterCondition["operator"],
        ...(value.value === undefined ? {} : { value: value.value as never }),
      };
  }
  return { property: known.id, operator: "is_empty" };
}

/** Keeps the operator and value when both still make sense, else starts over for the new type. */
export function conditionForProperty(
  current: FilterCondition,
  known: SpaceKnownDatabaseProperty,
): FilterCondition {
  const keep =
    filterOperatorsFor(known.type).includes(current.operator) &&
    !operatorNeedsValue(current.operator);
  return keep ? { property: known.id, operator: current.operator } : defaultCondition(known);
}

/** A new operator on the same property: keeps the value only when the shape is the same. */
export function conditionForOperator(
  current: FilterCondition,
  known: SpaceKnownDatabaseProperty,
  operator: FilterCondition["operator"],
): FilterCondition {
  const { value: _value, ...rest } = current;
  const next = { ...rest, operator };
  if (!operatorNeedsValue(operator)) return next;
  const sameShape =
    operatorNeedsValue(current.operator) &&
    current.value !== undefined &&
    (current.operator === "within") === (operator === "within") &&
    (current.operator === "in_group" || current.operator === "not_in_group") ===
      (operator === "in_group" || operator === "not_in_group");
  if (sameShape) return { ...next, value: current.value };
  const fresh = defaultValueFor(known, operator);
  return fresh === null || fresh.value === undefined
    ? next
    : { ...next, value: fresh.value as never };
}
