import { useState } from "react";
import { SPACE_PAGE_ICONS, normalizeSpacePageIcon } from "@t2code/client-runtime/spaces";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";

export function SpaceEmojiPicker({
  onChoose,
  onRemove,
}: {
  onChoose: (icon: string) => void;
  onRemove?: () => void;
}) {
  const [text, setText] = useState("");
  const typed = normalizeSpacePageIcon(text);
  return (
    <>
      <div className="grid grid-cols-8 gap-1" role="group" aria-label="Icons">
        {SPACE_PAGE_ICONS.map((icon) => (
          <Button
            key={icon}
            variant="ghost"
            size="icon-sm"
            aria-label={`Use ${icon}`}
            onClick={() => onChoose(icon)}
          >
            {icon}
          </Button>
        ))}
      </div>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (typed) onChoose(typed);
        }}
      >
        <Input
          aria-label="Type an emoji"
          placeholder="Type an emoji"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <Button type="submit" variant="outline" disabled={!typed}>
          Use
        </Button>
      </form>
      {onRemove ? (
        <Button className="mt-2" variant="ghost" size="sm" onClick={onRemove}>
          Remove
        </Button>
      ) : null}
    </>
  );
}
