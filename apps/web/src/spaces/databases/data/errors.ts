function field(failure: unknown, key: string): unknown {
  return typeof failure === "object" && failure !== null ? Reflect.get(failure, key) : undefined;
}

const DATABASE_REASONS: Record<string, string> = {
  duplicate_name: "That name is already used.",
  last_option: "A property needs at least one option.",
  last_view: "A database needs at least one view.",
  last_data_source: "A database needs at least one data source.",
  invalid_view: "That view change isn't valid.",
  not_a_row: "That page isn't a row of this database.",
  invalid_time_zone: "Your time zone isn't supported by this server.",
};

const LIMITS: Record<string, string> = {
  maxRowsPerDataSource: "This database has reached its row limit.",
  maxPropertiesPerDataSource: "This database has reached its property limit.",
  maxViewsPerDatabase: "This database has reached its view limit.",
  maxOptionsPerProperty: "This property has reached its option limit.",
};

/** Plain copy for a failed database request. */
export function databaseErrorMessage(failure: unknown): string {
  const tag = field(failure, "_tag");
  if (tag === "SpaceDatabaseError") {
    const reason = field(failure, "reason");
    if (typeof reason === "string" && DATABASE_REASONS[reason]) return DATABASE_REASONS[reason];
    return "The database request couldn't be completed.";
  }
  if (tag === "SpaceLimitExceededError") {
    const limit = field(failure, "limit");
    return (typeof limit === "string" && LIMITS[limit]) || "That is over a limit of this database.";
  }
  if (tag === "SpaceValidationError") {
    if (field(failure, "reason") === "trashed") return "This item is in the trash.";
    return "That value isn't valid.";
  }
  if (tag === "SpacesUnavailableError") return "Databases aren't available on this server.";
  if (failure instanceof Error && failure.message) return failure.message;
  return "Something went wrong. Try again.";
}
