import { RotateCcwIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { PropertyTypeIcon } from "../primitives/PropertyTypeIcon";
import { propertyTypeMeta } from "../primitives/propertyTypes";
import { useViewControls } from "./useViewControls";

export function DeletedProperties() {
  const { dataSource, canEditSchema, actions } = useViewControls();
  if (dataSource.deletedProperties.length === 0) return null;
  return (
    <div className="space-y-1 border-t pt-2">
      <span className="text-xs text-muted-foreground">Deleted properties</span>
      {dataSource.deletedProperties.map((property) => (
        <div key={property.id} className="flex items-center gap-2">
          <PropertyTypeIcon type={property.type} />
          <span className="min-w-0 flex-1 truncate text-sm">{property.name}</span>
          <span className="text-xs text-muted-foreground">
            {propertyTypeMeta(property.type).label}
          </span>
          <Button
            variant="ghost-muted"
            size="xs"
            disabled={!canEditSchema}
            aria-label={`Restore ${property.name}`}
            onClick={() =>
              void actions.updateSchema([{ op: "restoreProperty", propertyId: property.id }])
            }
          >
            <RotateCcwIcon />
            Restore
          </Button>
        </div>
      ))}
    </div>
  );
}
