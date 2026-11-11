import { knownProperty } from "@t2code/client-runtime/spaces";
import type { SpacePropertyId } from "@t2code/contracts/spaces";
import { compile, completions, typeLabel, type FormulaCompletion } from "@t2code/shared/formula";
import { useDeferredValue, useId, useRef, useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { databaseErrorDetail, databaseErrorMessage } from "@t2code/client-runtime/spaces";
import { nextConfig } from "../controls/propertyConfig";
import { useDatabase, useDatabaseActions } from "../shell/context";
import { FormulaCompletions } from "./FormulaCompletions";
import { FormulaInput } from "./FormulaInput";
import { FormulaReference } from "./FormulaReference";
import { mapServerDetail, positionOf, segmentsOf, viewerTimeZone } from "./formulaText";
import { previewText } from "./preview";
import { useFormulaSchema } from "./useFormulaSchema";
import { useSampleRow } from "./useSampleRow";

interface Refusal {
  /** The text the server refused, so a stale underline is not drawn over edited text. */
  readonly source: string;
  readonly message: string;
}

/** The dialog that edits one formula property: typed text, suggestions, errors, result and reference. */
function FormulaEditor({
  propertyId,
  onClose,
}: {
  readonly propertyId: SpacePropertyId;
  readonly onClose: () => void;
}) {
  const { dataSource, model } = useDatabase();
  const actions = useDatabaseActions();
  const property = dataSource.properties[propertyId];
  const known = property === undefined ? null : knownProperty(property);
  const saved = known?.type === "formula" ? known.config.expression : "";
  const [text, setText] = useState(saved);
  const [caret, setCaret] = useState(saved.length);
  const [suggest, setSuggest] = useState<"off" | "typed" | "manual">("off");
  const [active, setActive] = useState(0);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const messageId = useId();
  const [now] = useState(() => Date.now());
  const timeZone = viewerTimeZone();

  const { schema, loading } = useFormulaSchema(dataSource);
  const sample = useSampleRow(dataSource);
  // Checking is deferred: a long formula never holds up the keystroke that edited it.
  const checked = useDeferredValue(text);
  const result = compile(checked, schema);
  const settled = checked === text;
  const first = result.diagnostics[0];
  const disabled = !model.permissions.schema;
  const dirty = text !== saved;

  const items = suggest === "off" ? [] : completions(text, caret, schema);
  const visible =
    items.length > 0 &&
    (suggest === "manual" || items[0]!.kind === "property" || items[0]!.from < caret);
  const shown = visible ? items : [];
  const current = Math.min(active, Math.max(0, shown.length - 1));

  const preview =
    result.compiled !== null && sample !== null && known?.type === "formula"
      ? previewText(result.compiled, dataSource, sample.row, {
          relatedPages: sample.relatedPages,
          now,
          timeZone,
        })
      : null;

  const diagnostics =
    refusal?.source === text
      ? [mapServerDetail(refusal.message, text)].flatMap((mapped) =>
          mapped === null ? [] : [mapped],
        )
      : [];
  const segments = segmentsOf(text, [...(settled ? result.diagnostics : []), ...diagnostics]);

  const replace = (from: number, to: number, insert: string) => {
    const element = textareaRef.current;
    if (element === null) return;
    // Writing through the element keeps the caret where the user expects after the insert.
    element.focus();
    element.setRangeText(insert, from, to, "end");
    setText(element.value);
    setCaret(element.selectionStart);
    setRefusal(null);
  };
  const accept = (item: FormulaCompletion) => {
    replace(item.from, item.to, item.insert);
    setSuggest("off");
    setActive(0);
  };
  const insertAtCaret = (insert: string) => {
    const element = textareaRef.current;
    replace(element?.selectionStart ?? text.length, element?.selectionEnd ?? text.length, insert);
  };

  const save = async () => {
    if (known?.type !== "formula" || saving) return;
    setSaving(true);
    const submitted = text;
    const done = await actions.updateSchema(
      [
        {
          op: "updateProperty",
          propertyId,
          config: nextConfig(known, { expression: submitted }),
        },
      ],
      undefined,
      {
        onFailure: (failure) =>
          setRefusal({
            source: submitted,
            message: databaseErrorDetail(failure) ?? databaseErrorMessage(failure),
          }),
      },
    );
    setSaving(false);
    if (done !== null) onClose();
  };
  const canSave =
    !disabled && !saving && dirty && settled && result.diagnostics.length === 0 && !loading;

  const requestClose = () => (dirty ? setConfirmDiscard(true) : onClose());
  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // IME composition owns Enter, Tab and the arrows until it ends.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (shown.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : shown.length - 1;
        setActive((current + step) % shown.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        accept(shown[current]!);
        return;
      }
    }
    if (event.key === " " && event.ctrlKey) {
      event.preventDefault();
      setSuggest("manual");
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (canSave) void save();
    }
  };

  const message = refusal?.source === text ? refusal.message : first?.message;
  const position =
    first === undefined || refusal?.source === text ? null : positionOf(checked, first.start);

  return (
    <>
      <Dialog
        open
        onOpenChange={(next, details) => {
          if (next) return;
          if (details.reason === "escape-key" && shown.length > 0) {
            details.cancel();
            setSuggest("off");
            return;
          }
          requestClose();
        }}
      >
        <DialogPopup className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              Edit formula{property === undefined ? "" : `: ${property.name}`}
            </DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_16rem]">
              <div className="min-w-0 space-y-2">
                <FormulaInput
                  value={text}
                  segments={segments}
                  textareaRef={textareaRef}
                  disabled={disabled}
                  invalid={message !== undefined}
                  describedBy={messageId}
                  listboxId={shown.length > 0 ? listId : undefined}
                  activeId={shown.length > 0 ? `${listId}-${current}` : undefined}
                  onChange={(value, at) => {
                    setText(value);
                    setCaret(at);
                    setSuggest("typed");
                    setActive(0);
                    setRefusal(null);
                  }}
                  onCaret={setCaret}
                  onKeyDown={onKeyDown}
                  onCompositionEnd={() => setSuggest("typed")}
                />
                <FormulaCompletions id={listId} items={shown} active={current} onPick={accept} />
                <div id={messageId} aria-live="polite" className="min-h-10 space-y-1 text-xs">
                  {message === undefined ? (
                    <p className="text-muted-foreground">
                      {loading
                        ? "Loading related databases…"
                        : result.compiled === null
                          ? ""
                          : `Result: ${typeLabel(result.compiled.type)}`}
                    </p>
                  ) : (
                    <p role="alert" className="text-destructive-foreground">
                      {position === null ? "" : `${position.line}:${position.column} `}
                      {message}
                    </p>
                  )}
                  {preview === null || message !== undefined ? null : (
                    <p className="truncate text-muted-foreground">
                      Preview on {sample?.row.title || "Untitled"}:{" "}
                      <span data-testid="formula-preview" className="text-foreground">
                        {preview === "" ? "(empty)" : preview}
                      </span>
                    </p>
                  )}
                </div>
              </div>
              <FormulaReference schema={schema} disabled={disabled} onInsert={insertAtCaret} />
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button variant="ghost" onClick={requestClose}>
              Cancel
            </Button>
            <Button disabled={!canSave} onClick={() => void save()}>
              Save
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Your edits to this formula won't be saved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Keep editing</AlertDialogClose>
            <AlertDialogClose render={<Button variant="destructive" />} onClick={onClose}>
              Discard
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

export default FormulaEditor;
