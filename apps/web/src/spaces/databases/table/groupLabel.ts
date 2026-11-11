import type { SpaceGroupBucket, SpaceKnownDatabaseProperty } from "@t2code/contracts/spaces";

import type { OptionHint } from "./tableTypes";

const STATUS_GROUP_LABEL: Record<string, string> = {
  todo: "To-do",
  in_progress: "In progress",
  complete: "Complete",
};

export interface GroupLabel {
  readonly text: string;
  /** Set for option groups: rendered as a chip. */
  readonly color?: string;
}

/** What a group header shows: the option chip, the status group, or the server's label. */
export function groupLabel(
  bucket: Pick<SpaceGroupBucket, "key" | "label">,
  known: SpaceKnownDatabaseProperty | null,
  propertyName: string,
  optionHint: OptionHint,
): GroupLabel {
  const key = bucket.key as { kind: string } & Record<string, unknown>;
  switch (key.kind) {
    case "empty":
      return { text: `No ${propertyName}` };
    case "option": {
      const id = String(key.optionId);
      const option =
        known?.type === "select" || known?.type === "multi_select" || known?.type === "status"
          ? known.config.options.find((entry) => entry.id === id)
          : undefined;
      const hint = option === undefined ? optionHint(known?.id ?? "", id) : undefined;
      return {
        text: option?.name ?? hint?.name ?? bucket.label ?? "Option",
        color: option?.color ?? hint?.color ?? "default",
      };
    }
    case "status_group":
      return { text: STATUS_GROUP_LABEL[String(key.group)] ?? bucket.label ?? String(key.group) };
    case "checkbox":
      return { text: key.value === true ? "Checked" : "Unchecked" };
    case "text":
      return { text: bucket.label ?? String(key.value) };
    case "date":
      return { text: bucket.label ?? String(key.start) };
    case "number_range":
      return { text: bucket.label ?? `${String(key.start)} to ${String(key.end)}` };
    default:
      return { text: bucket.label ?? "Group" };
  }
}
