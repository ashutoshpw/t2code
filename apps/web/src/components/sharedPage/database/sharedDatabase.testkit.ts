import { vi } from "vite-plus/test";

/** Plain JSON in the wire shape of the public database routes. */
const prop = (id: string, name: string, type: string, config: object = {}, position = 1) => ({
  id,
  name,
  type,
  config,
  position,
});

export const row = (id: string, title: string, cells: Record<string, unknown> = {}) => ({
  id,
  title,
  cells,
});

export const view = (
  id: string,
  type: string,
  extra: Record<string, unknown> = {},
  properties: ReadonlyArray<{ propertyId: string; width?: number; wrap?: boolean }> = [],
) => ({
  id,
  dataSourceId: "ds1",
  name: type[0]!.toUpperCase() + type.slice(1),
  type,
  properties,
  layout: {},
  ...extra,
});

export const SOURCE_PROPERTIES = {
  title: prop("title", "Name", "title", {}, 0),
  st: prop("st", "Status", "select", { options: [] }, 1),
  n: prop("n", "Score", "number", {}, 2),
  d: prop("d", "Due", "date", {}, 3),
  rel: prop("rel", "Related", "relation", { dataSourceId: "ds2", limit: "many" }, 4),
};

export const description = (
  views: ReadonlyArray<object>,
  title = "Tasks",
  properties: Record<string, object> = SOURCE_PROPERTIES,
) => ({
  database: { id: "db1", title },
  dataSources: [{ id: "ds1", name: "Tasks", properties }],
  views,
});

export const window = (rows: ReadonlyArray<object>, extra: Record<string, unknown> = {}) => ({
  rows,
  relatedPages: {},
  options: {},
  nextCursor: null,
  ...extra,
});

export interface Call {
  readonly route: string;
  readonly params: URLSearchParams;
  readonly headers: Record<string, string>;
}

export const refuse = (reason: "inactive" | "unavailable" | "invalid", status = 403) => ({
  status,
  body: { reason, message: reason },
});

type Reply = unknown;
export interface ShareHandlers {
  readonly page?: (call: Call) => Reply;
  readonly database?: (call: Call) => Reply;
  readonly query?: (call: Call) => Reply;
  readonly row?: (call: Call) => Reply;
}

const ROUTES = {
  "/api/shared-page/page": "page",
  "/api/shared-page/database": "database",
  "/api/shared-page/database/query": "query",
  "/api/shared-page/database/row": "row",
} as const;

const isRefusal = (reply: unknown): reply is { status: number; body: object } =>
  typeof reply === "object" && reply !== null && "status" in reply && "body" in reply;

/** A fetch stub for the public routes; it records every call. */
export function shareFetch(handlers: ShareHandlers) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "https://host.example");
    const name = ROUTES[url.pathname as keyof typeof ROUTES];
    const headers = Object.fromEntries(Object.entries(init?.headers ?? {}));
    const call: Call = { route: url.pathname, params: url.searchParams, headers };
    calls.push(call);
    const reply = name === undefined ? undefined : handlers[name]?.(call);
    if (reply === undefined)
      return Response.json({ reason: "invalid", message: "x" }, { status: 404 });
    return isRefusal(reply)
      ? Response.json(reply.body, { status: reply.status })
      : Response.json(reply);
  });
  return { fetch, calls, queries: () => calls.filter((call) => call.route.endsWith("/query")) };
}
