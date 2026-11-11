import { useDatabase } from "../shell/context";
import { AddPropertyButton } from "./AddPropertyButton";
import { PropertyMenu } from "./PropertyMenu";

/** Stands in for the table in control tests: a header row built from the property menu. */
export default function ControlsStub() {
  const { columns } = useDatabase();
  return (
    <div role="row" aria-label="Header">
      {columns
        .filter((column) => column.visible)
        .map((column) => (
          <PropertyMenu
            key={column.property.id}
            propertyId={column.property.id}
            render={<button type="button">{column.property.name}</button>}
          />
        ))}
      <AddPropertyButton render={<button type="button">Add property</button>} />
    </div>
  );
}
