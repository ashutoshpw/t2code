import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";

import { byteLength, canonical, databaseLimits } from "../../CorePolicy.ts";
import * as SpacesSql from "../../SpacesSql.ts";
import { parseJson } from "../Json.ts";
import { plainRuns } from "../CellCodec.ts";
import type { Property } from "../SchemaStore.ts";
import * as Aggregates from "./Aggregates.ts";
import { type Levels, filteredRows } from "./Cte.ts";
import * as Cursor from "./Cursor.ts";
import { alwaysHasEmpty, enumerate, rawOf, toKey } from "./Group.ts";
import type { Plan } from "./Plan.ts";
import * as Rows from "./Rows.ts";
import { orderBy } from "./Sort.ts";
import type { GroupSpec, KeyValue } from "./Types.ts";

type Raw = Record<string, unknown>;

interface Node {
  readonly raw: KeyValue;
  readonly key: C.SpaceKnownGroupKey;
  readonly count: number;
  readonly sample: string | null;
  children: Node[];
}

const norm = (value: unknown): KeyValue =>
  typeof value === "bigint"
    ? Number(value)
    : typeof value === "number" || typeof value === "string"
      ? value
      : null;

/** Counts per bucket of one level, in bucket order (non-empty buckets, empty last). */
const countRows = Effect.fn("SpacesDatabases.countBuckets")(function* (
  plan: Plan,
  levels: 1 | 2,
  spec: GroupSpec,
  property: Property,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const key = levels === 1 ? "g" : "sg";
  const order = levels === 1 ? "go" : "so";
  const direction = spec.descending ? sql` DESC` : sql``;
  const enumerated = enumerate(property, spec) !== undefined;
  const ordering = enumerated
    ? sql``
    : spec.by.kind === "page"
      ? sql` ORDER BY (${sql.literal(key)} IS NULL), (${sql.literal(order)} IS NULL), ${sql.literal(order)}${direction}, ${sql.literal(key)}`
      : sql` ORDER BY (${sql.literal(key)} IS NULL), ${sql.literal(key)}${direction}`;
  const limit =
    enumerated || levels === 2 ? sql`` : sql` LIMIT ${databaseLimits.maxGroupBuckets + 1}`;
  const by = levels === 1 ? sql`g` : sql`g, sg`;
  const columns = levels === 1 ? sql`g` : sql`g, sg`;
  return yield* sql<Raw>`${filteredRows(plan, levels, false)}
    SELECT ${columns}, COUNT(DISTINCT page_id) AS n, MIN(page_id) AS sample FROM f GROUP BY ${by}${ordering}${limit}`;
});

/** Orders one level's buckets: every enumerated bucket (zero-filled), or what the rows found. */
const arrange = (
  property: Property,
  spec: GroupSpec,
  found: readonly {
    readonly raw: KeyValue;
    readonly count: number;
    readonly sample: string | null;
  }[],
): Node[] => {
  const node = (raw: KeyValue, count: number, sample: string | null): Node => ({
    raw,
    key: toKey(spec, raw),
    count,
    sample,
    children: [],
  });
  const enumerated = enumerate(property, spec);
  if (enumerated === undefined) return found.map((row) => node(row.raw, row.count, row.sample));
  const counts = new Map(found.map((row) => [canonical(toKey(spec, row.raw)), row] as const));
  const keys = spec.descending ? [...enumerated].reverse() : enumerated;
  const nodes = keys.map((key) => {
    const row = counts.get(canonical(key));
    return node(rawOf(key), row?.count ?? 0, row?.sample ?? null);
  });
  const empty = found.find((row) => row.raw === null);
  if (empty !== undefined || alwaysHasEmpty(spec))
    nodes.push(node(null, empty?.count ?? 0, empty?.sample ?? null));
  return nodes;
};

/** The label of text and page buckets: the plain text of one member, or the target's title. */
const labels = Effect.fn("SpacesDatabases.bucketLabels")(function* (
  plan: Plan,
  spec: GroupSpec,
  all: readonly Node[],
) {
  const sql = yield* SpacesSql.SpacesSql;
  const result = new Map<string, string>();
  const nodes = all.filter((node) => node.raw !== null);
  if (spec.by.kind !== "page" && spec.by.kind !== "exact") return result;
  const pageIds = nodes.flatMap((node) => {
    const id = spec.by.kind === "page" ? node.raw : node.sample;
    return typeof id === "string" ? [id] : [];
  });
  if (pageIds.length === 0) return result;
  if (spec.by.kind === "page" || spec.type === "title") {
    const titles = yield* sql<{
      readonly page_id: string;
      readonly title: string;
    }>`SELECT page_id, title FROM spaces_pages WHERE page_id IN ${sql.in(pageIds)}`;
    const byPage = new Map(titles.map((row) => [row.page_id, row.title] as const));
    for (const node of nodes) {
      const id = spec.by.kind === "page" ? node.raw : node.sample;
      const title = typeof id === "string" ? byPage.get(id) : undefined;
      if (title !== undefined) result.set(String(node.raw), title);
    }
    return result;
  }
  const cells = yield* sql<{
    readonly page_id: string;
    readonly value: string | null;
  }>`SELECT page_id, value FROM spaces_db_cells WHERE property_id = ${spec.propertyId}
    AND page_id IN ${sql.in(pageIds)} AND ord = 0`;
  const byPage = new Map(cells.map((row) => [row.page_id, row.value] as const));
  for (const node of nodes) {
    const stored = node.sample === null ? undefined : byPage.get(node.sample);
    if (stored === undefined || stored === null) continue;
    const value = parseJson(stored);
    if (typeof value === "string") result.set(String(node.raw), value);
    else if (Array.isArray(value))
      result.set(
        String(node.raw),
        plainRuns(
          value.flatMap((run) =>
            typeof run === "object" &&
            run !== null &&
            !Array.isArray(run) &&
            typeof run.text === "string"
              ? [{ text: run.text }]
              : [],
          ),
        ),
      );
  }
  return result;
});

/** Cuts a level at maxGroupBuckets; the empty bucket after a full set of enumerated ones is no truncation. */
const cut = (nodes: Node[]) => {
  const max = databaseLimits.maxGroupBuckets;
  const onlyEmptyOver = nodes.length === max + 1 && nodes[max]!.raw === null;
  return onlyEmptyOver
    ? { nodes, truncated: false }
    : { nodes: nodes.slice(0, max), truncated: nodes.length > max };
};

interface Leaf {
  readonly node: Node;
  readonly parent: Node | undefined;
}

interface GroupsResult {
  readonly groups: readonly C.SpaceGroupBucket[];
  readonly truncated: boolean;
  readonly total: number;
  readonly aggregates: readonly C.SpaceAggregateResult[] | undefined;
  readonly related: Record<string, C.SpaceRelatedPage>;
}

const leafId = (leaf: Leaf) =>
  Aggregates.bucketId(
    leaf.parent ? leaf.parent.raw : leaf.node.raw,
    leaf.parent ? leaf.node.raw : null,
  );

export const groups = Effect.fn("SpacesDatabases.groups")(function* (
  plan: Plan,
  options: {
    readonly rowsPerGroup: number;
    readonly aggregates: boolean;
    readonly cover?: boolean;
  },
) {
  const sql = yield* SpacesSql.SpacesSql;
  const { snapshot } = plan.c;
  const spec = plan.e.group!;
  const sub = plan.e.subGroup;
  const property = snapshot.byId.get(spec.propertyId)!;
  const subProperty = sub ? snapshot.byId.get(sub.propertyId)! : undefined;
  const read = (rows: readonly Raw[], at: "g" | "sg") =>
    rows.map((row) => ({
      raw: norm(row[at]),
      parent: norm(row.g),
      count: Number(row.n),
      sample: typeof row.sample === "string" ? row.sample : null,
    }));

  const level1 = read(yield* countRows(plan, 1, spec, property), "g");
  const topFound = arrange(property, spec, level1);
  const { nodes: top, truncated } = cut(topFound);
  let truncatedSub = false;
  if (sub && subProperty) {
    const rows = read(yield* countRows(plan, 2, sub, subProperty), "sg");
    const byParent = new Map<KeyValue, typeof rows>();
    for (const row of rows) byParent.set(row.parent, [...(byParent.get(row.parent) ?? []), row]);
    for (const node of top) {
      const children = arrange(subProperty, sub, byParent.get(node.raw) ?? []);
      const cutChildren = cut(children);
      truncatedSub ||= cutChildren.truncated;
      node.children = cutChildren.nodes;
    }
  }

  const leaves: Leaf[] = sub
    ? top.flatMap((parent) => parent.children.map((node) => ({ node, parent })))
    : top.map((node) => ({ node, parent: undefined }));

  // Previews: at most maxQueryRows rows in all, so many buckets get fewer rows each.
  const fetched = new Map<string, Rows.Hit[]>();
  let hydrated = new Map<string, C.SpaceDatabaseRow>();
  let related: Record<string, C.SpaceRelatedPage> = {};
  const occupied = leaves.filter((leaf) => leaf.node.count > 0);
  const requested = Math.min(options.rowsPerGroup, databaseLimits.maxGroupPreviewRows);
  if (requested > 0 && occupied.length > 0) {
    const per = Math.max(
      1,
      Math.min(requested, Math.floor(databaseLimits.maxQueryRows / occupied.length)),
    );
    const chosen = occupied.slice(0, Math.floor(databaseLimits.maxQueryRows / per));
    const levels: Levels = sub ? 2 : 1;
    const conditions = chosen.map((leaf) =>
      sub ? sql`(g IS ${leaf.parent!.raw} AND sg IS ${leaf.node.raw})` : sql`g IS ${leaf.node.raw}`,
    );
    const partition = sub ? sql`g, sg` : sql`g`;
    const rows = yield* sql<Raw>`${filteredRows(plan, levels, true)}
      SELECT * FROM (SELECT f.*, row_number() OVER (PARTITION BY ${partition}
        ORDER BY ${orderBy(plan.c, plan.keys, "")}) AS rn FROM f)
      WHERE rn <= ${per} AND (${sql.or(conditions)}) ORDER BY rn`;
    const hits: Rows.Hit[] = [];
    for (const row of rows) {
      const hit = Rows.hitOf(plan, row);
      hits.push(hit);
      const id = Aggregates.bucketId(norm(row.g), sub ? norm(row.sg) : null);
      fetched.set(id, [...(fetched.get(id) ?? []), hit]);
    }
    const result = yield* Rows.hydrate(plan, hits, { cover: options.cover === true });
    hydrated = new Map(result.rows.map((row) => [row.page.id, row] as const));
    related = result.related;
  }

  const total = yield* Rows.total(plan);
  const withAggregates = options.aggregates && plan.e.aggregates.length > 0;
  const overall = withAggregates
    ? (yield* Aggregates.aggregates(
        plan,
        0,
        plan.e.aggregates,
        new Map([[Aggregates.bucketId(null, null), total]]),
      ))(Aggregates.bucketId(null, null))
    : undefined;
  const topAggregates = withAggregates
    ? yield* Aggregates.aggregates(
        plan,
        1,
        plan.e.aggregates,
        new Map(level1.map((row) => [Aggregates.bucketId(row.raw, null), row.count] as const)),
      )
    : undefined;
  const subAggregates =
    withAggregates && sub
      ? yield* Aggregates.aggregates(
          plan,
          2,
          plan.e.aggregates,
          new Map(leaves.map((leaf) => [leafId(leaf), leaf.node.count] as const)),
        )
      : undefined;

  const topLabels = yield* labels(plan, spec, top);
  const subLabels = new Map<string, string>();
  if (sub)
    for (const parent of top)
      for (const [id, label] of yield* labels(plan, sub, parent.children))
        subLabels.set(`${String(parent.raw)}\u0000${id}`, label);

  const printFor = (leaf: Leaf) =>
    Cursor.fingerprint({
      dataSourceId: plan.dataSourceId,
      c: plan.c,
      effective: {
        ...plan.e,
        scope: {
          ...plan.e.scope,
          group: leaf.parent ? leaf.parent.key : leaf.node.key,
          ...(leaf.parent ? { subGroup: leaf.node.key } : {}),
        },
      },
    });

  const build = Effect.fn("SpacesDatabases.buildBuckets")(function* (keep: number) {
    const leafBucket = Effect.fn("SpacesDatabases.leafBucket")(function* (leaf: Leaf) {
      const hits = (fetched.get(leafId(leaf)) ?? []).slice(0, keep);
      const rows = hits.flatMap((hit) => {
        const row = hydrated.get(hit.pageId);
        return row ? [row] : [];
      });
      const last = hits[hits.length - 1];
      const label = leaf.parent
        ? subLabels.get(`${String(leaf.parent.raw)}\u0000${String(leaf.node.raw)}`)
        : topLabels.get(String(leaf.node.raw));
      const aggregates = leaf.parent ? subAggregates : topAggregates;
      return {
        key: leaf.node.key,
        ...(label === undefined ? {} : { label }),
        count: leaf.node.count,
        ...(withAggregates && aggregates ? { aggregates: aggregates(leafId(leaf)) } : {}),
        rows,
        nextCursor:
          last && leaf.node.count > rows.length
            ? yield* Cursor.encode(plan.environmentId, printFor(leaf), last.at)
            : null,
      } satisfies C.SpaceGroupBucket;
    });
    const buckets: C.SpaceGroupBucket[] = [];
    for (const node of top) {
      if (!sub) {
        buckets.push(yield* leafBucket({ node, parent: undefined }));
        continue;
      }
      const subGroups: C.SpaceGroupBucket[] = [];
      for (const child of node.children)
        subGroups.push(yield* leafBucket({ node: child, parent: node }));
      const label = topLabels.get(String(node.raw));
      buckets.push({
        key: node.key,
        ...(label === undefined ? {} : { label }),
        count: node.count,
        ...(withAggregates && topAggregates
          ? { aggregates: topAggregates(Aggregates.bucketId(node.raw, null)) }
          : {}),
        rows: [],
        nextCursor: null,
        subGroups,
      });
    }
    return buckets;
  });

  // Over the response cap: halve the previews until it fits, then give up.
  let keep = Math.max(...[...fetched.values()].map((hits) => hits.length), 0);
  const overhead = byteLength({ total, ...(overall ? { overall } : {}), related });
  for (;;) {
    const buckets = yield* build(keep);
    const size = byteLength(buckets) + overhead;
    if (size <= databaseLimits.maxQueryResponseBytes || keep === 0) {
      if (size > databaseLimits.maxQueryResponseBytes)
        return yield* new C.SpaceLimitExceededError({
          limit: "databases.maxQueryResponseBytes",
          actual: size,
          maximum: databaseLimits.maxQueryResponseBytes,
        });
      return {
        groups: buckets,
        truncated: truncated || truncatedSub,
        total,
        aggregates: overall,
        related,
      } satisfies GroupsResult;
    }
    keep = Math.floor(keep / 2);
  }
});
