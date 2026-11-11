import { knownProperty } from "@t2code/client-runtime/spaces";
import type { SpaceSharedDataSource, SpaceSharedOption } from "@t2code/contracts";
import type { SpaceDatabaseProperty, SpaceKnownDatabaseProperty } from "@t2code/contracts/spaces";

import { isDatabaseColor } from "~/spaces/databases/primitives/colors";

type Options = Readonly<Record<string, ReadonlyArray<SpaceSharedOption>>>;
type OptionProperty = "select" | "multi_select" | "status";

const isOptionProperty = (type: string): type is OptionProperty =>
  type === "select" || type === "multi_select" || type === "status";

function withOptions(
  property: SpaceDatabaseProperty,
  options: ReadonlyArray<SpaceSharedOption>,
): SpaceDatabaseProperty {
  const config =
    typeof property.config === "object" &&
    property.config !== null &&
    !Array.isArray(property.config)
      ? property.config
      : {};
  return {
    ...property,
    config: {
      ...config,
      options: options.map((option) => ({
        id: option.id,
        name: option.name,
        color: isDatabaseColor(option.color) ? option.color : "default",
        ...(property.type === "status" ? { group: option.group ?? "todo" } : {}),
      })),
    },
  };
}

/** A sanitized property with the option names the loaded windows carry merged into its config. */
export function sharedKnownProperty(
  property: SpaceDatabaseProperty,
  options: Options,
): SpaceKnownDatabaseProperty | null {
  return knownProperty(
    isOptionProperty(property.type) ? withOptions(property, options[property.id] ?? []) : property,
  );
}

export function sharedKnownProperties(
  source: SpaceSharedDataSource,
  options: Options,
): ReadonlyMap<string, SpaceKnownDatabaseProperty | null> {
  return new Map(
    Object.values(source.properties).map((property) => [
      property.id,
      sharedKnownProperty(property, options),
    ]),
  );
}

export const optionHintFor =
  (options: Options) =>
  (propertyId: string, optionId: string): { name: string; color: string } | undefined => {
    const option = options[propertyId]?.find((entry) => entry.id === optionId);
    return option === undefined ? undefined : { name: option.name, color: option.color };
  };
