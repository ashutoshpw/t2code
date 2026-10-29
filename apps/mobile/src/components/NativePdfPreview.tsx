import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import Pdf from "react-native-pdf-jsi";

import { FilePreviewLoading, FilePreviewNotice } from "../features/files/FilePreviewFeedback";
import { pdfInitialPage, pdfLinkUrl, preparePdfPreview } from "../lib/pdfPreview";
import { tryOpenExternalUrl } from "../lib/openExternalUrl";
import { ControlPill } from "./ui/ControlPill";

export interface PdfTracking {
  readonly initialPage: number;
  readonly mount: () => void;
  readonly loaded: (pages: number) => boolean;
  readonly current: () => boolean;
  readonly pageChanged: (page: number, pages: number) => boolean;
  readonly hold: () => () => void;
  readonly dispose: () => void;
}
export function NativePdfPreview(props: {
  readonly uri: string;
  readonly onRetry: () => void;
  readonly tracking?: PdfTracking;
}) {
  const [localUri, setLocalUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cached = useRef<Awaited<ReturnType<typeof preparePdfPreview>>>(null);

  // oxlint-disable-next-line t2code/react-effect-budget -- Own the temporary PDF file and admission lease for this exact mounted source.
  useEffect(() => {
    const controller = new AbortController();
    props.tracking?.mount();
    let finished = false;
    let release: (() => void) | undefined;
    const releaseOnce = () => {
      release?.();
      release = undefined;
    };
    const prepare = async () => {
      release = props.tracking?.hold();
      return preparePdfPreview(props.uri, controller.signal);
    };
    void prepare()
      .then((file) => {
        if (controller.signal.aborted) file?.dispose();
        else {
          cached.current = file;
          setLocalUri(file?.uri ?? null);
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "The PDF could not be loaded.");
        }
      })
      .finally(() => {
        finished = true;
        if (controller.signal.aborted) releaseOnce();
      });
    return () => {
      controller.abort();
      props.tracking?.dispose();
      cached.current?.dispose();
      cached.current = null;
      if (finished) releaseOnce();
    };
  }, [props.uri, props.tracking]);

  if (error) {
    return (
      <View className="flex-1 gap-4 bg-card">
        <FilePreviewNotice title="Could not load PDF">{error}</FilePreviewNotice>
        <View className="items-center">
          <ControlPill label="Try again" variant="pill" onPress={props.onRetry} />
        </View>
      </View>
    );
  }
  if (localUri === null) return <FilePreviewLoading message="Loading PDF..." background="card" />;

  return (
    <Pdf
      source={{ uri: localUri }}
      page={props.tracking?.initialPage ?? pdfInitialPage(props.uri)}
      onLoadComplete={(pages) => {
        if (props.tracking && !props.tracking.loaded(pages))
          setError("PDF exceeds the supported 2,000-page bound or its source changed.");
      }}
      onPageChanged={(page, pages) => {
        if (props.tracking && !props.tracking.pageChanged(page, pages))
          setError("PDF page or source is unavailable.");
      }}
      fitPolicy={0}
      trustAllCerts={false}
      enableAnnotationRendering
      enableDoubleTapZoom
      onPressLink={(href) => {
        const url = pdfLinkUrl(href, props.uri);
        if ((!props.tracking || props.tracking.current()) && url !== null)
          void tryOpenExternalUrl(url, "file-preview");
      }}
      onError={() => {
        cached.current?.dispose();
        cached.current = null;
        setError("The PDF could not be rendered. It may be damaged or password protected.");
      }}
      style={{ flex: 1, width: "100%" }}
    />
  );
}
