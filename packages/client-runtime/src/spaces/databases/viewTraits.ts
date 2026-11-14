export interface ViewTraits {
  readonly filter: boolean;
  readonly sort: boolean;
  readonly search: boolean;
  /** The settings row label, or no row. */
  readonly group: "group" | "x_axis" | null;
  /** The Property visibility row. */
  readonly properties: boolean;
  readonly loadLimit: boolean;
  readonly subItems: boolean;
  readonly newRow: boolean;
  readonly openPagesIn: boolean;
}

const full: ViewTraits = {
  filter: true,
  sort: true,
  search: true,
  group: "group",
  properties: true,
  loadLimit: true,
  subItems: false,
  newRow: true,
  openPagesIn: true,
};

const TRAITS: Readonly<Record<string, ViewTraits>> = {
  table: { ...full, subItems: true },
  board: full,
  list: { ...full, subItems: true },
  gallery: full,
  calendar: { ...full, loadLimit: false },
  timeline: { ...full, loadLimit: false },
  chart: {
    ...full,
    sort: false,
    group: "x_axis",
    properties: false,
    loadLimit: false,
    newRow: false,
  },
  form: {
    filter: false,
    sort: false,
    search: false,
    group: null,
    properties: false,
    loadLimit: false,
    subItems: false,
    newRow: false,
    openPagesIn: false,
  },
  feed: { ...full, group: null },
};

const UNKNOWN: ViewTraits = {
  filter: false,
  sort: false,
  search: false,
  group: null,
  properties: true,
  loadLimit: false,
  subItems: false,
  newRow: false,
  openPagesIn: false,
};

/** What a view type offers in the toolbar and the settings menu. */
export const viewTraits = (type: string | undefined): ViewTraits =>
  (type === undefined ? undefined : TRAITS[type]) ?? UNKNOWN;
