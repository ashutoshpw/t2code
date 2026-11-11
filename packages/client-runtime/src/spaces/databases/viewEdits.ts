import type {
  SpaceDatabaseView,
  SpaceViewId,
  SpaceViewProperty,
  SpaceViewUpdateInput,
} from "@t2code/contracts/spaces";

export type ViewPatch = Omit<
  SpaceViewUpdateInput,
  "environmentId" | "mutationId" | "receiptEpoch" | "viewId"
>;

/** Mirrors the server's `updateView`: each field replaces, null removes, properties merge per id. */
export function applyViewPatch(view: SpaceDatabaseView, patch: ViewPatch): SpaceDatabaseView {
  let next: { -readonly [K in keyof SpaceDatabaseView]: SpaceDatabaseView[K] } = { ...view };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.type !== undefined) next.type = patch.type;
  if (patch.sorts !== undefined) next.sorts = patch.sorts;
  if (patch.layout !== undefined) next.layout = patch.layout;
  for (const key of ["filter", "group", "subGroup"] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null) {
      const { [key]: _removed, ...rest } = next;
      next = rest as typeof next;
    } else {
      next = { ...next, [key]: value };
    }
  }
  if (patch.properties?.set !== undefined) {
    const entries = new Map<string, SpaceViewProperty>(
      next.properties.map((entry) => [entry.propertyId, entry]),
    );
    for (const [id, change] of Object.entries(patch.properties.set)) {
      if (change === null) {
        entries.delete(id);
        continue;
      }
      const current = entries.get(id);
      const merged: Record<string, unknown> = {
        ...current,
        propertyId: id,
        visible: change.visible ?? current?.visible ?? true,
      };
      for (const key of ["width", "wrap", "aggregate"] as const) {
        const value = change[key];
        if (value === null) delete merged[key];
        else if (value !== undefined) merged[key] = value;
      }
      entries.set(id, merged as SpaceViewProperty);
    }
    next.properties = [...entries.values()];
  }
  if (patch.properties?.order !== undefined) {
    const order = patch.properties.order;
    const byId = new Map(next.properties.map((entry) => [entry.propertyId, entry]));
    const head = order.map(
      (id): SpaceViewProperty => byId.get(id) ?? { propertyId: id, visible: false },
    );
    next.properties = [
      ...head,
      ...next.properties.filter((entry) => !order.includes(entry.propertyId)),
    ];
  }
  return next;
}

export interface ViewEdit {
  readonly id: number;
  readonly viewId: SpaceViewId;
  readonly patch: ViewPatch;
  /** Database revision that carried the edit, once acknowledged. */
  readonly ack: number | undefined;
}
export type ViewEdits = ReadonlyArray<ViewEdit>;

export function queueViewEdit(edits: ViewEdits, edit: ViewEdit, settledRevision = 0): ViewEdits {
  return [...edits.filter((entry) => entry.ack === undefined || entry.ack > settledRevision), edit];
}

export function ackViewEdit(edits: ViewEdits, id: number, databaseRevision: number): ViewEdits {
  return edits.map((edit) => (edit.id === id ? { ...edit, ack: databaseRevision } : edit));
}

export function dropViewEdit(edits: ViewEdits, id: number): ViewEdits {
  return edits.filter((edit) => edit.id !== id);
}

/** The view with every edit applied that the server's copy (at `databaseRevision`) does not carry yet. */
export function effectiveView(
  view: SpaceDatabaseView,
  edits: ViewEdits,
  databaseRevision: number,
): SpaceDatabaseView {
  let result = view;
  for (const edit of [...edits].sort((a, b) => a.id - b.id)) {
    if (edit.viewId !== view.id) continue;
    if (edit.ack !== undefined && edit.ack <= databaseRevision) continue;
    result = applyViewPatch(result, edit.patch);
  }
  return result;
}
