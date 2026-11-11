import type { SpaceDatabaseQueryInput } from "@t2code/contracts/spaces";

/** JSON with sorted keys and no undefined members, so equal inputs give equal strings. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const members = Object.entries(value)
      .filter(([, member]) => member !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`);
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Identifies a query's windows: the input without its cursor. */
export const queryKey = (input: SpaceDatabaseQueryInput): string => {
  const { cursor: _cursor, ...rest } = input;
  return canonicalJson(rest);
};
