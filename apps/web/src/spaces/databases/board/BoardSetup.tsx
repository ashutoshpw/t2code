import { SPACE_GROUPABLE_TYPES, type SpacePropertyId } from "@t2code/contracts/spaces";

import { Button } from "~/components/ui/button";
import { defaultGroupBy } from "../controls/groupOptions";
import { uniqueName } from "../controls/propertyConfig";
import { useDatabase, useDatabaseActions } from "../shell/context";
import { PropertyPicker } from "../primitives/PropertyPicker";

const FIRST = ["status", "select"];

/** A board with no group: pick the property its columns come from, or add a Status one. */
export function BoardSetup() {
  const { model, columns } = useDatabase();
  const actions = useDatabaseActions();
  const canGroup = model.permissions.views;
  const properties = columns
    .map((column) => column.property)
    .filter((property) => (SPACE_GROUPABLE_TYPES as ReadonlyArray<string>).includes(property.type))
    .sort(
      (a, b) =>
        Number(!FIRST.includes(a.type)) - Number(!FIRST.includes(b.type)) ||
        FIRST.indexOf(a.type) - FIRST.indexOf(b.type),
    );
  const hasChoice = columns.some((column) => FIRST.includes(column.property.type));
  const setGroup = (property: SpacePropertyId, type: string) => {
    const by = defaultGroupBy(type);
    actions.editView({ group: { property, ...(by === undefined ? {} : { by }) } });
  };
  return (
    <section
      aria-label="Set up the board"
      className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-4 py-8 text-center"
    >
      <p className="text-sm font-medium">Group this board by a property</p>
      {canGroup ? (
        <>
          <PropertyPicker
            label="Group by"
            placeholder="Choose a property"
            properties={properties}
            value={null}
            onChange={(id) =>
              setGroup(id, properties.find((property) => property.id === id)?.type ?? "")
            }
          />
          {hasChoice ? null : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void actions
                  .addProperty({
                    name: uniqueName(
                      "Status",
                      columns.map((column) => column.property.name),
                    ),
                    type: "status",
                  })
                  .then((id) => {
                    if (id !== null) setGroup(id, "status");
                  });
              }}
            >
              Add a Status property
            </Button>
          )}
        </>
      ) : (
        <p className="text-xs text-muted-foreground">This view has no group yet.</p>
      )}
    </section>
  );
}
