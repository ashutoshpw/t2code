import type { CellTextContext } from "@t2code/client-runtime/spaces";
import type { SpaceDatabaseRow, SpaceGroupKey } from "@t2code/contracts/spaces";
import { View, useColorScheme } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { ControlPill } from "../../../components/ui/ControlPill";
import { optionColor } from "./optionColors";
import { RowCard } from "./RowCard";
import type { ListItem, ViewForm } from "./viewForms";

export interface DatabaseItemHandlers {
  readonly onOpenRow: (row: SpaceDatabaseRow) => void;
  readonly onMore: (bucket: SpaceGroupKey | null) => void;
}

/** One flat list item; the block maps these in a plain view and the screen hands them to a LegendList. */
export function DatabaseListItem(props: {
  readonly item: ListItem;
  readonly form: ViewForm;
  readonly context: CellTextContext;
  readonly handlers: DatabaseItemHandlers;
}) {
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  const { item } = props;
  switch (item.kind) {
    case "header": {
      const color = item.label.color === undefined ? null : optionColor(item.label.color, scheme);
      return (
        <View className="flex-row items-center gap-2 px-4 pb-1 pt-3">
          <View
            className={color === null ? "" : "rounded-md px-2 py-0.5"}
            style={color === null ? undefined : { backgroundColor: color.background }}
          >
            <Text
              accessibilityRole="header"
              className="text-sm font-semibold text-foreground"
              style={color === null ? undefined : { color: color.text }}
            >
              {item.label.text}
            </Text>
          </View>
          {item.count === null ? null : (
            <Text className="text-sm text-foreground-muted">{item.count}</Text>
          )}
        </View>
      );
    }
    case "row":
      return (
        <RowCard
          row={item.row}
          form={props.form}
          context={props.context}
          span={item.span}
          onOpen={props.handlers.onOpenRow}
        />
      );
    case "more":
      return (
        <View className="items-start px-4 py-2">
          <ControlPill
            variant="pill"
            label={item.loading ? "Loading…" : item.text}
            disabled={item.loading}
            onPress={() => props.handlers.onMore(item.bucket)}
          />
        </View>
      );
    case "note":
      return <Text className="px-4 py-2 text-sm text-foreground-muted">{item.text}</Text>;
  }
}

/** A bounded, non-virtualized rendering for the inline block: the caller passes only a few items. */
export function DatabaseViewList(props: {
  readonly items: ReadonlyArray<ListItem>;
  readonly form: ViewForm;
  readonly context: CellTextContext;
  readonly handlers: DatabaseItemHandlers;
}) {
  return (
    <View>
      {props.items.map((item) => (
        <DatabaseListItem
          key={item.key}
          item={item}
          form={props.form}
          context={props.context}
          handlers={props.handlers}
        />
      ))}
    </View>
  );
}
