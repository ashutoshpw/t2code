import { nextOptionColor } from "@t2code/client-runtime/spaces";
import type { SpaceDatabaseOption } from "@t2code/contracts/spaces";
import { useState } from "react";
import { Pressable, ScrollView, View, useColorScheme } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../../components/ui/AppText";
import { ControlPill } from "../../../components/ui/ControlPill";
import { ListChoiceRow } from "../../../components/ui/ListChoiceRow";
import { ListSection } from "../../../components/ui/ListSection";
import { Sheet } from "../../../components/ui/Sheet";
import { optionColor } from "./optionColors";
import {
  choiceRows,
  commitValue,
  type CellDraft,
  type CellEditor,
  type CommitResult,
  type TextField,
} from "./cellEdit";

export type SheetEditor = Exclude<CellEditor, { kind: "readonly" } | { kind: "checkbox" }>;

const KEYBOARD: Record<
  TextField,
  "default" | "numbers-and-punctuation" | "url" | "email-address" | "phone-pad"
> = {
  title: "default",
  text: "default",
  number: "numbers-and-punctuation",
  url: "url",
  email: "email-address",
  phone: "phone-pad",
};

export const ADD_OPTIONS_FOOTER = "Add options on desktop.";

/** Edits one cell of a row: a text field, a list of the property's options, or a pair of dates. */
export function CellEditSheet(props: {
  readonly title: string;
  readonly editor: SheetEditor;
  /**
   * Called with the value to send once the draft is valid; the sheet closes after it. A returned
   * message keeps the sheet open, with the typed value, and shows it.
   */
  readonly onCommit: (value: Extract<CommitResult, { ok: true }>["value"]) => string | null;
  readonly onClose: () => void;
  /** Adds an option to the property and resolves its id; null when it could not be added. */
  readonly onCreateOption?: (name: string) => Promise<string | null>;
}) {
  const insets = useSafeAreaInsets();
  const [error, setError] = useState<string | null>(null);
  // Options created here stay until the property refreshes, so their chips render and validate.
  const [created, setCreated] = useState<ReadonlyArray<SpaceDatabaseOption>>([]);
  const base = props.editor;
  const editor: SheetEditor =
    base.kind === "choice"
      ? {
          ...base,
          options: [
            ...base.options,
            ...created.filter((fresh) => !base.options.some((o) => o.id === fresh.id)),
          ],
        }
      : base;
  const submit = (draft: CellDraft) => {
    const result = commitValue(editor, draft);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    const refused = props.onCommit(result.value);
    if (refused !== null) {
      setError(refused);
      return;
    }
    props.onClose();
  };
  return (
    <Sheet title={props.title} onClose={props.onClose}>
      <ScrollView
        className="flex-1 bg-sheet-solid"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-4 p-5"
        contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}
        keyboardShouldPersistTaps="handled"
      >
        {editor.kind === "text" ? (
          <TextBody editor={editor} error={error} onSubmit={submit} onEdit={() => setError(null)} />
        ) : editor.kind === "choice" ? (
          <ChoiceBody
            editor={editor}
            error={error}
            onSubmit={submit}
            onCreateOption={
              props.onCreateOption === undefined
                ? undefined
                : async (name) => {
                    const id = await props.onCreateOption?.(name);
                    if (id === null || id === undefined) return null;
                    setCreated((list) => [
                      ...list,
                      {
                        id: id as SpaceDatabaseOption["id"],
                        name,
                        color: nextOptionColor(editor.options.map((option) => option.color)),
                      },
                    ]);
                    return id;
                  }
            }
          />
        ) : (
          <DateBody editor={editor} error={error} onSubmit={submit} onEdit={() => setError(null)} />
        )}
      </ScrollView>
    </Sheet>
  );
}

function TextBody(props: {
  readonly editor: Extract<SheetEditor, { kind: "text" }>;
  readonly error: string | null;
  readonly onEdit: () => void;
  readonly onSubmit: (draft: CellDraft) => void;
}) {
  const { editor } = props;
  const [text, setText] = useState(editor.initial);
  return (
    <>
      <TextInput
        accessibilityLabel="Value"
        value={text}
        onChangeText={(value) => {
          setText(value);
          props.onEdit();
        }}
        autoFocus
        autoCapitalize={editor.field === "title" || editor.field === "text" ? "sentences" : "none"}
        autoCorrect={editor.field === "title" || editor.field === "text"}
        keyboardType={KEYBOARD[editor.field]}
        multiline={editor.multiline}
        textAlignVertical={editor.multiline ? "top" : "center"}
        className={editor.multiline ? "min-h-32" : undefined}
        returnKeyType={editor.multiline ? "default" : "done"}
        onSubmitEditing={
          editor.multiline ? undefined : () => props.onSubmit({ kind: "text", text })
        }
      />
      <ErrorLine message={props.error} />
      <SaveButton onPress={() => props.onSubmit({ kind: "text", text })} />
    </>
  );
}

function ChoiceBody(props: {
  readonly editor: Extract<SheetEditor, { kind: "choice" }>;
  readonly error: string | null;
  readonly onSubmit: (draft: CellDraft) => void;
  readonly onCreateOption: ((name: string) => Promise<string | null>) | undefined;
}) {
  const { editor } = props;
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  const [selected, setSelected] = useState(editor.selected);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const rows = choiceRows(editor.options, query, props.onCreateOption !== undefined);
  const toggle = (id: string) => {
    if (!editor.multiple) {
      props.onSubmit({ kind: "choice", selected: selected.includes(id) ? [] : [id] });
      return;
    }
    setSelected((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    );
  };
  const remove = (id: string) => {
    if (!editor.multiple) props.onSubmit({ kind: "choice", selected: [] });
    else setSelected((current) => current.filter((entry) => entry !== id));
  };
  const create = async (name: string) => {
    setCreating(true);
    const id = await props.onCreateOption?.(name);
    setCreating(false);
    if (id === null || id === undefined) return;
    setQuery("");
    if (editor.multiple) setSelected((current) => [...current, id]);
    else props.onSubmit({ kind: "choice", selected: [id] });
  };
  const chosen = selected.flatMap((id) => editor.options.find((option) => option.id === id) ?? []);
  return (
    <>
      {chosen.length === 0 ? null : (
        <View className="flex-row flex-wrap gap-1.5">
          {chosen.map((option) => {
            const color = optionColor(option.color, scheme);
            return (
              <View
                key={option.id}
                className="flex-row items-center gap-1 rounded-md px-2 py-1"
                style={{ backgroundColor: color.background }}
              >
                <Text className="text-sm" style={{ color: color.text }}>
                  {option.name}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${option.name}`}
                  hitSlop={8}
                  onPress={() => remove(option.id)}
                >
                  <Text className="text-sm" style={{ color: color.text }}>
                    ×
                  </Text>
                </Pressable>
              </View>
            );
          })}
        </View>
      )}
      <TextInput
        accessibilityLabel="Search or create an option"
        placeholder="Search or create an option"
        value={query}
        onChangeText={setQuery}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
      />
      <ListSection footer={props.onCreateOption === undefined ? ADD_OPTIONS_FOOTER : undefined}>
        {rows.options.map((option, index) => (
          <ListChoiceRow
            key={option.id}
            label={option.name}
            leading={
              <View
                className="size-3 rounded-full"
                style={{ backgroundColor: optionColor(option.color, scheme).background }}
              />
            }
            selected={selected.includes(option.id)}
            separated={index > 0}
            onPress={() => toggle(option.id)}
          />
        ))}
        {rows.create === null ? null : (
          <ListChoiceRow
            label={`Create \u201c${rows.create}\u201d`}
            selected={false}
            separated={rows.options.length > 0}
            disabled={creating}
            onPress={() => void create(rows.create ?? "")}
          />
        )}
      </ListSection>
      <ErrorLine message={props.error} />
      {editor.multiple ? (
        <SaveButton label="Done" onPress={() => props.onSubmit({ kind: "choice", selected })} />
      ) : (
        <View className="flex-row">
          <ControlPill
            variant="pill"
            label="Clear"
            disabled={selected.length === 0}
            onPress={() => props.onSubmit({ kind: "choice", selected: [] })}
          />
        </View>
      )}
    </>
  );
}

function DateBody(props: {
  readonly editor: Extract<SheetEditor, { kind: "date" }>;
  readonly error: string | null;
  readonly onEdit: () => void;
  readonly onSubmit: (draft: CellDraft) => void;
}) {
  const [start, setStart] = useState(props.editor.start);
  const [end, setEnd] = useState(props.editor.end);
  const field = (label: string, value: string, set: (value: string) => void) => (
    <View className="gap-1">
      <Text className="text-sm text-foreground-muted">{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={(next) => {
          set(next);
          props.onEdit();
        }}
        placeholder="YYYY-MM-DD"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="numbers-and-punctuation"
      />
    </View>
  );
  return (
    <>
      {field("Start (YYYY-MM-DD)", start, setStart)}
      {field("End (optional)", end, setEnd)}
      <ErrorLine message={props.error} />
      <SaveButton onPress={() => props.onSubmit({ kind: "date", start, end })} />
    </>
  );
}

function ErrorLine(props: { readonly message: string | null }) {
  return props.message === null ? null : (
    <Text accessibilityLiveRegion="polite" className="text-sm text-danger-foreground">
      {props.message}
    </Text>
  );
}

function SaveButton(props: { readonly label?: string; readonly onPress: () => void }) {
  return (
    <View className="flex-row">
      <ControlPill variant="primary" label={props.label ?? "Save"} onPress={props.onPress} />
    </View>
  );
}
