import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";
import {
  T2_WORDMARK_ASPECT_RATIO,
  T2_WORDMARK_PATH,
  T2_WORDMARK_VIEW_BOX,
} from "@t2code/shared/t2Wordmark";

const ThemedPath = withUniwind(Path);

/**
 * The "T2" brand mark, matching the web T2Wordmark SVG. Width derives from
 * the shared viewBox aspect ratio.
 */
export function T2Wordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  return (
    <Svg
      accessibilityLabel="T2"
      height={props.height}
      width={props.height * T2_WORDMARK_ASPECT_RATIO}
      viewBox={T2_WORDMARK_VIEW_BOX}
    >
      <ThemedPath
        d={T2_WORDMARK_PATH}
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
    </Svg>
  );
}
