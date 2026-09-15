import type { SVGProps } from "react";
import { T2_WORDMARK_PATH, T2_WORDMARK_VIEW_BOX } from "@t2code/shared/t2Wordmark";

export function T2Wordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox={T2_WORDMARK_VIEW_BOX} xmlns="http://www.w3.org/2000/svg">
      <path d={T2_WORDMARK_PATH} fill="currentColor" />
    </svg>
  );
}
