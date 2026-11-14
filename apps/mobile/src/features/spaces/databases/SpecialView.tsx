import type { EnvironmentId } from "@t2code/contracts";
import type {
  SpaceDataSource,
  SpaceDatabaseRow,
  SpaceDatabaseView,
} from "@t2code/contracts/spaces";
import type { ReactElement } from "react";
import { ScrollView, View } from "react-native";

import { ChartPanel } from "./ChartPanel";
import { FeedList } from "./FeedList";
import { FormFillPanel } from "./FormFillPanel";
import type { DatabaseModel } from "./useDatabaseModel";
import { BLOCK_PREVIEW_ROWS } from "./viewForms";

/** Chart, feed and form views are drawn by their own panels, not by the row-card path. */
export const isSpecialView = (view: SpaceDatabaseView): boolean =>
  view.type === "chart" || view.type === "feed" || view.type === "form";

interface SpecialProps {
  readonly environmentId: EnvironmentId;
  readonly model: DatabaseModel;
  readonly view: SpaceDatabaseView;
  readonly dataSource: SpaceDataSource;
  readonly onOpenRow: (row: SpaceDatabaseRow) => void;
}

/** The inline version in a page: the chart, the first cards of a feed, or the form. */
export function SpecialBlockView(props: SpecialProps) {
  switch (props.view.type) {
    case "chart":
      return <ChartPanel {...props} />;
    case "feed":
      return <FeedList {...props} maxCards={BLOCK_PREVIEW_ROWS} />;
    default:
      return <FormFillPanel {...props} />;
  }
}

/** The full screen: a feed windows its own list; the others scroll under the same header. */
export function SpecialScreenView(props: SpecialProps & { readonly header: ReactElement }) {
  if (props.view.type === "feed")
    return <FeedList {...props} maxCards={Number.MAX_SAFE_INTEGER} windowed />;
  return (
    <ScrollView
      className="flex-1"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingBottom: 32 }}
    >
      {props.header}
      <View>
        <SpecialBlockView {...props} />
      </View>
    </ScrollView>
  );
}
