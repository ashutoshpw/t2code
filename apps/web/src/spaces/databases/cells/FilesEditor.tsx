import { useState, type KeyboardEvent } from "react";
import { XIcon } from "lucide-react";
import type { SpaceCellValue, SpaceFileItem } from "@t2code/contracts/spaces";

import { Button } from "~/components/ui/button";
import { useOptionalDatabase } from "../shell/context";
import type { CellEditorProps } from "./CellEditor";
import { EditorPopover } from "./EditorPopover";
import { useSettleOnce } from "./settle";

const DEFAULT_MAX_ITEMS = 20;

const filesOf = (value: SpaceCellValue | undefined): SpaceFileItem[] =>
  Array.isArray(value)
    ? value.filter(
        (item): item is SpaceFileItem =>
          typeof item === "object" &&
          item !== null &&
          !Array.isArray(item) &&
          typeof item.name === "string",
      )
    : [];

/** An http or https link, named after the last path segment. */
export function fileFromUrl(text: string): SpaceFileItem | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const segment = url.pathname.split("/").findLast((part) => part !== "");
  return { name: decodeURIComponent(segment ?? url.hostname), url: url.toString() };
}

/** Links only: add by URL, remove. Uploads are not part of this editor. */
export function FilesEditor(props: CellEditorProps) {
  const { known, value, onChange } = props;
  const database = useOptionalDatabase();
  const max = database?.model.limits.maxCellItems ?? DEFAULT_MAX_ITEMS;
  const [url, setUrl] = useState("");
  const [invalid, setInvalid] = useState(false);
  const { cancel } = useSettleOnce(props);
  const items = filesOf(value);

  const add = () => {
    const file = fileFromUrl(url);
    if (file === null) return setInvalid(true);
    onChange?.([...items, file]);
    setUrl("");
    setInvalid(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      add();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  };

  return (
    <EditorPopover label={known.name} onClose={cancel}>
      <div className="flex w-full flex-col gap-1 p-2 text-sm">
        {items.length === 0 ? <p className="px-1 text-muted-foreground">No files</p> : null}
        <ul className="flex flex-col">
          {items.map((item, index) => (
            <li
              key={`${item.name}:${"url" in item ? item.url : index}`}
              className="flex items-center gap-1"
            >
              {"url" in item ? (
                <a
                  href={item.url}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 flex-1 truncate underline"
                >
                  {item.name}
                </a>
              ) : (
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
              )}
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Remove ${item.name}`}
                onClick={() => {
                  const next = items.filter((_, at) => at !== index);
                  onChange?.(next.length === 0 ? null : next);
                }}
              >
                <XIcon />
              </Button>
            </li>
          ))}
        </ul>
        {items.length >= max ? (
          <p className="px-1 text-muted-foreground">{`A cell holds at most ${max} files`}</p>
        ) : (
          <>
            <input
              autoFocus
              aria-label="File URL"
              aria-invalid={invalid}
              placeholder="Paste a link and press Enter"
              value={url}
              className="h-7 rounded-md border bg-transparent px-2 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              onChange={(event) => {
                setUrl(event.target.value);
                setInvalid(false);
              }}
              onKeyDown={onKeyDown}
            />
            {invalid ? (
              <p role="alert" className="px-1 text-destructive-foreground">
                Enter an http or https link
              </p>
            ) : null}
          </>
        )}
      </div>
    </EditorPopover>
  );
}
