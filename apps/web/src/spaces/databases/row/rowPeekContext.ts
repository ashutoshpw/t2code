import { createContext } from "react";
import type { SpacePageId } from "@t2code/contracts/spaces";

/** Provided by the page surface in route mode; null where a row opens in place. */
export const RowPeekContext = createContext<((pageId: SpacePageId) => void) | null>(null);
