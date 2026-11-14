import { useState } from "react";
import { NativePdfPreview } from "./NativePdfPreview";
import type { PdfPosition } from "../lib/pdfPosition";
export interface PdfTrackingOwner {
  readonly position: PdfPosition;
  readonly current: () => boolean;
  readonly hold: () => () => void;
  readonly retry: () => void;
}
function BoundPdf({ uri, owner }: { uri: string; owner: PdfTrackingOwner }) {
  const [tracking] = useState(() => ({ ...owner.position.bind(owner.current), hold: owner.hold }));
  return <NativePdfPreview uri={uri} tracking={tracking} onRetry={owner.retry} />;
}
export function TrackedPdfPreview(props: { uri: string; owner: PdfTrackingOwner }) {
  return <BoundPdf key={props.uri} {...props} />;
}
