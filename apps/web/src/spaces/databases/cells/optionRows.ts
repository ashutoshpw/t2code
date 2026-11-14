import type {
  SpaceCellValue,
  SpaceKnownDatabaseProperty,
  SpaceStatusGroup,
} from "@t2code/contracts/spaces";

export type OptionKnown = Extract<
  SpaceKnownDatabaseProperty,
  { type: "select" | "multi_select" | "status" }
>;
export type Option = OptionKnown["config"]["options"][number];

const STATUS_GROUPS: ReadonlyArray<{ group: SpaceStatusGroup; label: string }> = [
  { group: "todo", label: "To-do" },
  { group: "in_progress", label: "In progress" },
  { group: "complete", label: "Complete" },
];

export type OptionRow =
  | { readonly kind: "heading"; readonly group: SpaceStatusGroup; readonly label: string }
  | { readonly kind: "option"; readonly option: Option }
  | { readonly kind: "create"; readonly name: string; readonly group?: SpaceStatusGroup };

export const idsOf = (value: SpaceCellValue | undefined): string[] =>
  Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string")
    : typeof value === "string"
      ? [value]
      : [];

/** The chosen options in value order; ids the property no longer has are skipped. */
export function selectedOptions(
  known: OptionKnown,
  value: SpaceCellValue | undefined,
): ReadonlyArray<Option> {
  const options: Option[] = [];
  for (const id of idsOf(value)) {
    const option = known.config.options.find((entry) => entry.id === id);
    if (option !== undefined) options.push(option);
  }
  return options;
}

/** The rows the picker lists for a search; status options sit under their group headings. */
export function optionRows(
  known: OptionKnown,
  query: string,
  {
    canCreate,
    createGroup,
  }: { readonly canCreate: boolean; readonly createGroup: SpaceStatusGroup },
): ReadonlyArray<OptionRow> {
  const name = query.trim();
  const needle = name.toLowerCase();
  const matching = known.config.options.filter((option) =>
    option.name.toLowerCase().includes(needle),
  );
  const offerCreate =
    canCreate &&
    needle !== "" &&
    !known.config.options.some((option) => option.name.toLowerCase() === needle);
  const rows: OptionRow[] = [];
  if (known.type !== "status") {
    for (const option of matching) rows.push({ kind: "option", option });
    if (offerCreate) rows.push({ kind: "create", name });
    return rows;
  }
  for (const { group, label } of STATUS_GROUPS) {
    const inGroup = matching.filter((option) => "group" in option && option.group === group);
    const creates = offerCreate && group === createGroup;
    if (inGroup.length === 0 && !creates) continue;
    rows.push({ kind: "heading", group, label });
    for (const option of inGroup) rows.push({ kind: "option", option });
    if (creates) rows.push({ kind: "create", name, group });
  }
  return rows;
}
