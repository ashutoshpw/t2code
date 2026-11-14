import { useContext, useRef, useState } from "react";

import { Popover, PopoverPopup } from "~/components/ui/popover";
import { cn } from "~/lib/utils";
import { useCommitOnBlur } from "~/hooks/useCommitOnBlur";
import { SpaceEmojiPicker } from "../../SpaceEmojiPicker";
import type { DatabaseBlockActions } from "../blocks/actions";
import type { DatabaseSurfaceHost } from "../blocks/DatabaseBlockHost";
import type { DatabaseModel } from "../data/useDatabaseModel";
import { DatabaseActionsContext } from "./context";
import { DatabaseIconButton } from "./DatabaseIconButton";
import { DatabaseTitleMenu } from "./DatabaseTitleMenu";
import { LinkedHeader } from "./LinkedHeader";

function TitleInput({
  value,
  page,
  inputRef,
  onCommit,
}: {
  readonly value: string;
  readonly page: boolean;
  readonly inputRef: React.RefObject<HTMLInputElement | null>;
  readonly onCommit: (title: string) => void;
}) {
  const cancelled = useRef(false);
  const field = useCommitOnBlur(value, (next) => {
    if (cancelled.current) cancelled.current = false;
    else onCommit(next);
  });
  return (
    <input
      ref={inputRef}
      aria-label="Database title"
      placeholder="Untitled database"
      size={Math.max(12, field.value.length + 1)}
      className={cn(
        "min-w-0 max-w-full rounded-sm bg-transparent px-1 outline-none placeholder:text-muted-foreground/60 focus-visible:bg-accent/40",
        page ? "h-12 text-3xl font-bold" : "h-8 text-lg font-semibold",
      )}
      value={field.value}
      onChange={field.onChange}
      onFocus={() => {
        cancelled.current = false;
        field.onFocus();
      }}
      onBlur={field.onBlur}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Escape") {
          cancelled.current = true;
          event.currentTarget.blur();
        } else field.onKeyDown(event);
      }}
    />
  );
}

/** Icon, title and hover menu of a database: inline on a page, or the large header of the full page. */
export function DatabaseTitle({
  model,
  blockActions,
  variant,
  linked,
  host,
  canEditLayout,
}: {
  readonly model: DatabaseModel;
  readonly blockActions: DatabaseBlockActions;
  readonly variant: "inline" | "page";
  readonly linked: boolean;
  readonly host: DatabaseSurfaceHost;
  readonly canEditLayout: boolean;
}) {
  const actions = useContext(DatabaseActionsContext);
  const { database, permissions } = model;
  const page = variant === "page";
  const writable = permissions.title && !linked;
  const input = useRef<HTMLInputElement>(null);
  const [row, setRow] = useState<HTMLDivElement | null>(null);
  const [pickingIcon, setPickingIcon] = useState(false);
  const choose = (icon: string | null) => {
    setPickingIcon(false);
    actions?.setDatabaseIcon(icon);
  };
  const glyph =
    database.icon === undefined ? null : (
      <DatabaseIconButton
        icon={database.icon}
        large={page}
        {...(writable ? { onClick: () => setPickingIcon(true) } : {})}
      />
    );
  return (
    <div ref={setRow} className="group/dbtitle flex min-w-0 flex-wrap items-center gap-1 ps-0.5">
      {page ? <div className="basis-full">{glyph}</div> : glyph}
      {linked ? (
        <LinkedHeader model={model} host={host} />
      ) : writable ? (
        <TitleInput
          value={database.title}
          page={page}
          inputRef={input}
          onCommit={(title) => actions?.renameDatabase(title)}
        />
      ) : page ? (
        <h1 className="truncate px-1 text-3xl font-bold">
          {database.title || "Untitled database"}
        </h1>
      ) : (
        <h3 className="truncate px-1 text-lg font-semibold">
          {database.title || "Untitled database"}
        </h3>
      )}
      <DatabaseTitleMenu
        model={model}
        blockActions={blockActions}
        page={page}
        linked={linked}
        canEditLayout={canEditLayout}
        onEditTitle={() => {
          input.current?.focus();
          input.current?.select();
        }}
        onEditIcon={() => setPickingIcon(true)}
      />
      <Popover open={pickingIcon} onOpenChange={setPickingIcon}>
        <PopoverPopup anchor={row} align="start" width="md">
          <SpaceEmojiPicker
            onChoose={choose}
            {...(database.icon === undefined ? {} : { onRemove: () => choose(null) })}
          />
        </PopoverPopup>
      </Popover>
    </div>
  );
}
