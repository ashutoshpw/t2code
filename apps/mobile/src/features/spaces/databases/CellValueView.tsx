import { Pressable, View, useColorScheme } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import type { CardLine, LineRelation } from "./cellText";
import { optionColor } from "./optionColors";

/**
 * The value of one property, read-only. Cards and the row page both draw cells through this, so
 * every property type has one look on a phone. Editing is layered on top by the row page.
 */
export function CellValueView(props: {
  readonly line: CardLine;
  /** Called for a related row whose data source is known; otherwise the title is plain text. */
  readonly onOpenRelated?: (related: LineRelation) => void;
  readonly numberOfLines?: number;
}) {
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  const { line } = props;
  if (line.chips !== undefined)
    return (
      <View className="flex-row flex-wrap gap-1.5">
        {line.chips.map((chip) => {
          const color = optionColor(chip.color, scheme);
          return (
            <View
              key={chip.id}
              className="rounded-md px-2 py-0.5"
              style={{ backgroundColor: color.background }}
            >
              <Text className="text-sm" style={{ color: color.text }} numberOfLines={1}>
                {chip.name}
              </Text>
            </View>
          );
        })}
      </View>
    );
  if (line.checked !== undefined)
    return (
      <Text className="text-sm text-foreground">{line.checked ? "Checked" : "Unchecked"}</Text>
    );
  if (line.related !== undefined)
    return (
      <View className="flex-row flex-wrap gap-1.5">
        {line.related.map((related) =>
          props.onOpenRelated !== undefined && related.dataSourceId !== undefined ? (
            <Pressable
              key={related.pageId}
              accessibilityRole="button"
              accessibilityLabel={`Open ${related.title}`}
              className="rounded-md bg-subtle px-2 py-0.5"
              onPress={() => props.onOpenRelated?.(related)}
            >
              <Text className="text-sm text-foreground" numberOfLines={1}>
                {related.title}
              </Text>
            </Pressable>
          ) : (
            <Text key={related.pageId} className="text-sm text-foreground" numberOfLines={1}>
              {related.title}
            </Text>
          ),
        )}
      </View>
    );
  return (
    <Text
      className={
        line.error
          ? "text-sm text-destructive"
          : line.unsupported
            ? "text-sm italic text-foreground-muted"
            : "text-sm text-foreground"
      }
      numberOfLines={props.numberOfLines}
    >
      {line.text}
    </Text>
  );
}
