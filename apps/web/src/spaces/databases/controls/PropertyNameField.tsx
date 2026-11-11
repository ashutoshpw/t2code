import type { SpacePropertyId } from "@t2code/contracts/spaces";
import { useState } from "react";

import { Input } from "~/components/ui/input";
import { useDatabaseActions } from "../shell/context";

/**
 * Commits a rename on Enter or blur and keeps showing the typed name until the schema answers
 * with a different stored name; a refusal (for example a duplicate name) puts the stored name back.
 */
export function PropertyNameField({
  propertyId,
  name,
  disabled,
  stopKeys = false,
}: {
  readonly propertyId: SpacePropertyId;
  readonly name: string;
  readonly disabled: boolean;
  /** Inside a menu, where typed characters would otherwise start item typeahead. */
  readonly stopKeys?: boolean;
}) {
  const actions = useDatabaseActions();
  const [edit, setEdit] = useState<string | null>(null);
  const [held, setHeld] = useState<{ typed: string; base: string } | null>(null);
  const commit = () => {
    if (edit === null) return;
    const next = edit.trim();
    setEdit(null);
    if (next === "" || next === name) return;
    setHeld({ typed: next, base: name });
    void actions.updateSchema([{ op: "updateProperty", propertyId, name: next }]).then((result) => {
      if (result === null) setHeld(null);
    });
  };
  return (
    <Input
      size="compact"
      aria-label="Property name"
      disabled={disabled}
      value={edit ?? (held !== null && held.base === name ? held.typed : name)}
      onChange={(event) => setEdit(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (stopKeys) event.stopPropagation();
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape" && edit !== null) {
          setEdit(null);
        }
      }}
    />
  );
}
