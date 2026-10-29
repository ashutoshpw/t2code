import { lazy, Suspense, useState } from "react";
import { View } from "react-native";
import { WebView } from "react-native-webview";

import type { PdfTrackingOwner } from "./TrackedPdfPreview";
import { FilePreviewLoading, FilePreviewNotice } from "../features/files/FilePreviewFeedback";

const TrackedPdfPreview = lazy(() =>
  import("./TrackedPdfPreview").then((module) => ({ default: module.TrackedPdfPreview })),
);

export function PdfPreview(props: { readonly uri: string; readonly tracking?: PdfTrackingOwner }) {
  const [error, setError] = useState<string | null>(null);
  if (props.tracking)
    return (
      <Suspense fallback={<FilePreviewLoading message="Loading PDF viewer…" background="card" />}>
        <TrackedPdfPreview uri={props.uri} owner={props.tracking} />
      </Suspense>
    );
  return (
    <View className="flex-1 bg-card">
      {error ? <FilePreviewNotice title="Could not load PDF">{error}</FilePreviewNotice> : null}
      <WebView
        source={{ uri: props.uri }}
        originWhitelist={["*"]}
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
        startInLoadingState
        onError={(event) =>
          setError(event.nativeEvent.description || "The PDF could not be loaded.")
        }
        onHttpError={(event) =>
          setError(`The server returned HTTP ${event.nativeEvent.statusCode}.`)
        }
        renderLoading={() => <FilePreviewLoading message="Loading PDF..." background="card" />}
        style={{ flex: 1, backgroundColor: "transparent" }}
      />
    </View>
  );
}
