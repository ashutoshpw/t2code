import { type CellTextContext } from "@t2code/client-runtime/spaces";
import type { SpaceDatabaseRow } from "@t2code/contracts/spaces";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { CellValueView } from "./CellValueView";
import { cardLines, rowDisplayTitle } from "./cellText";
import type { ViewForm } from "./viewForms";

/** One row of a view: its title and the few properties the form draws. Opens the row as a page. */
export function RowCard(props: {
  readonly row: SpaceDatabaseRow;
  readonly form: ViewForm;
  readonly context: CellTextContext;
  /** An agenda item that spans days: "Nov 9 → Nov 12". */
  readonly span?: string | null;
  readonly onOpen: (row: SpaceDatabaseRow) => void;
}) {
  const { row, form } = props;
  const title = rowDisplayTitle(row);
  const lines = cardLines(
    row,
    form.previewColumn === null ? form.columns : [form.previewColumn, ...form.columns],
    props.context,
  );
  const compact = form.kind === "compact";
  const showNames = !compact || form.showPropertyNames;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      className={
        compact
          ? "border-b border-border-subtle px-4 py-2.5"
          : "mx-4 mb-2 gap-1 rounded-2xl border border-border bg-grouped-card px-3.5 py-3"
      }
      onPress={() => props.onOpen(row)}
    >
      <Text className="text-base font-semibold text-foreground" numberOfLines={compact ? 1 : 2}>
        {row.page.icon ? `${row.page.icon} ` : ""}
        {title}
      </Text>
      {props.span ? <Text className="text-sm text-foreground-muted">{props.span}</Text> : null}
      {compact ? (
        lines.length > 0 ? (
          <Text className="text-sm text-foreground-muted" numberOfLines={1}>
            {lines
              .map((line) =>
                showNames && line.text !== "" ? `${line.name}: ${line.text}` : line.text,
              )
              .filter((text) => text !== "")
              .join(" · ")}
          </Text>
        ) : null
      ) : (
        lines.map((line) => (
          <View key={line.propertyId} className="flex-row flex-wrap items-center gap-x-2 gap-y-1">
            {showNames ? <Text className="text-sm text-foreground-muted">{line.name}</Text> : null}
            <CellValueView line={line} numberOfLines={2} />
          </View>
        ))
      )}
    </Pressable>
  );
}
