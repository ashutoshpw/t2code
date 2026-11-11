import { lazy, Suspense, type ReactNode } from "react";
import type { EnvironmentId } from "@t2code/contracts";
import type {
  SpaceCellValue,
  SpaceKnownDatabaseProperty,
  SpacePageId,
  SpaceRelatedPage,
} from "@t2code/contracts/spaces";

import { TextEditor } from "./TextEditor";

const OptionEditor = lazy(() =>
  import("./OptionEditor").then((m) => ({ default: m.OptionEditor })),
);
const DateEditor = lazy(() => import("./DateEditor").then((m) => ({ default: m.DateEditor })));
const FilesEditor = lazy(() => import("./FilesEditor").then((m) => ({ default: m.FilesEditor })));
const RelationEditor = lazy(() =>
  import("./RelationEditor").then((m) => ({ default: m.RelationEditor })),
);

export interface CellEditorProps {
  readonly known: SpaceKnownDatabaseProperty;
  readonly value: SpaceCellValue | undefined;
  readonly pageId: SpacePageId;
  /** The character that started the edit. */
  readonly seed?: string;
  /** `cell` fills the grid cell; `field` is a row page property. */
  readonly variant: "cell" | "field";
  readonly relatedPages: Readonly<Record<string, SpaceRelatedPage>>;
  /** Only the relation picker reads it; without it the picker uses the surrounding database. */
  readonly environmentId?: EnvironmentId;
  /**
   * At most once per close, except multi-value editors. `reason: "blur"` means focus is already
   * going elsewhere, so the host must not take it back.
   */
  readonly onCommit: (
    value: SpaceCellValue | null,
    move?: "right" | "left",
    reason?: "blur",
  ) => void;
  /** The relation picker reports pages it just picked so the host can draw them. */
  readonly onPicked?: (pages: Readonly<Record<string, SpaceRelatedPage>>) => void;
  /** Multi-value editors commit each toggle without closing. */
  readonly onChange?: (value: SpaceCellValue | null) => void;
  readonly onClose: () => void;
}

export function editorKind(type: string): "inline" | "popover" | "toggle" | "none" {
  switch (type) {
    case "title":
    case "text":
    case "number":
    case "url":
    case "email":
    case "phone":
      return "inline";
    case "select":
    case "multi_select":
    case "status":
    case "date":
    case "files":
    case "relation":
      return "popover";
    case "checkbox":
      return "toggle";
    default:
      return "none";
  }
}

function Editor(props: CellEditorProps): ReactNode {
  switch (props.known.type) {
    case "title":
    case "text":
    case "number":
    case "url":
    case "email":
    case "phone":
      return <TextEditor {...props} />;
    case "select":
    case "multi_select":
    case "status":
      return <OptionEditor {...props} />;
    case "date":
      return <DateEditor {...props} />;
    case "files":
      return <FilesEditor {...props} />;
    case "relation":
      return <RelationEditor {...props} />;
    default:
      return null;
  }
}

/** The editor of one property type; the popover ones load on first use. */
export function CellEditor(props: CellEditorProps): ReactNode {
  return (
    <Suspense fallback={null}>
      <Editor {...props} />
    </Suspense>
  );
}
