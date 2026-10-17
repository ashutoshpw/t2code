import { T2_MCP_TOOL_NAMES } from "@t2code/shared/t2McpToolPresentation";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Transcripts recorded before the T3 to T2 rename keep the server and tool
 * names the runtime no longer resolves, so their cards fall back to the
 * generic renderer. Rewrite the stored spellings rather than teaching the
 * runtime to accept both, which would keep the old names in code forever.
 *
 * Only identity-shaped strings are rewritten. Payload prose, paths and file
 * contents that merely mention the old name are left alone, because the same
 * spelling appears in projects, repositories and conversations that have
 * nothing to do with this rename.
 */
const LEGACY_TOOL_PREFIX = "t3_";
const CURRENT_TOOL_PREFIX = "t2_";

const legacyToolNames = [...T2_MCP_TOOL_NAMES]
  .filter((name) => name.startsWith(CURRENT_TOOL_PREFIX))
  .map((name) => [name.replace(CURRENT_TOOL_PREFIX, LEGACY_TOOL_PREFIX), name] as const)
  .sort(([left], [right]) => right.length - left.length);

const currentToolNameByLegacyName = new Map(legacyToolNames);

// A bare tool token, so `t3_task_status` rewrites without touching a longer
// name that happens to start with it. The leading class excludes `_` so the
// token still matches behind a server separator (`mcp__t2-code__t3_...`).
const LEGACY_TOOL_TOKEN = new RegExp(
  `(?<![A-Za-z0-9])(${legacyToolNames.map(([legacy]) => legacy).join("|")})(?![A-Za-z0-9_])`,
  "gu",
);

const LEGACY_SERVER_TOKEN = /t3[-_ ]?code/giu;
const LEGACY_SERVER_NAME = /^t3[-_ ]?code$/iu;
// `mcp__t3-code__t2_thread_send`, `t3_code.delegate_task`, `t3-code:...`,
// `mcp_t3-code_...`, `t3-code__...`, `t3-code/...`, `t3-code ...`,
// `t3-code-thread_..._delegate_task`.
const LEGACY_SERVER_QUALIFIED_TOOL =
  /^(?:mcp[-_]{1,2})?t3[-_ ]?code[-_.:/ ]{1,3}[A-Za-z0-9][A-Za-z0-9_.-]*(?::.*)?$/iu;
// `delegate_task_t3-code`, `delegate_task-t3-code`, `delegate_task.t3-code`
// and `delegate_task (t3-code MCP Server)`, with or without a trailing JSON
// argument block.
const LEGACY_SERVER_SUFFIXED_TOOL =
  /^[A-Za-z0-9][A-Za-z0-9_.-]*?(?: \(t3[-_ ]?code MCP Server\)(?::|$)|[-_.]t3[-_ ]?code$)/iu;
const LEGACY_THREAD_LINK = /t3-thread:\/\/v1\//giu;

export const rewriteLegacyMcpIdentity = (value: string): string => {
  const linked = value.replace(LEGACY_THREAD_LINK, "t2-thread://v1/");
  if (LEGACY_SERVER_NAME.test(linked)) return "t2-code";
  if (!LEGACY_SERVER_QUALIFIED_TOOL.test(linked) && !LEGACY_SERVER_SUFFIXED_TOOL.test(linked)) {
    return currentToolNameByLegacyName.get(linked) ?? linked;
  }
  return linked
    .replace(LEGACY_SERVER_TOKEN, "t2-code")
    .replace(LEGACY_TOOL_TOKEN, (match) => currentToolNameByLegacyName.get(match) ?? match);
};

const rewriteValue = (value: unknown, changed: { rewritten: boolean }): unknown => {
  if (typeof value === "string") {
    const next = rewriteLegacyMcpIdentity(value);
    if (next !== value) changed.rewritten = true;
    return next;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteValue(entry, changed));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, rewriteValue(entry, changed)]),
    );
  }
  return value;
};

const rewritePayload = (payload: string): string | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  const changed = { rewritten: false };
  const next = rewriteValue(parsed, changed);
  return changed.rewritten ? JSON.stringify(next) : null;
};

const rewriteText = (text: string): string | null => {
  const next = rewriteLegacyMcpIdentity(text);
  return next === text ? null : next;
};

const JSON_PAYLOAD_TARGETS = [
  { idColumn: "sequence", table: "orchestration_v2_events" },
  { idColumn: "effect_id", table: "orchestration_v2_effect_outbox" },
  { idColumn: "turn_item_id", table: "orchestration_v2_projection_turn_items" },
  { idColumn: "message_id", table: "orchestration_v2_projection_messages" },
  { idColumn: "plan_id", table: "orchestration_v2_projection_plans" },
  { idColumn: "node_id", table: "orchestration_v2_projection_nodes" },
  { idColumn: "run_id", table: "orchestration_v2_projection_runs" },
  { idColumn: "attempt_id", table: "orchestration_v2_projection_run_attempts" },
  {
    idColumn: "runtime_request_id",
    table: "orchestration_v2_projection_runtime_requests",
  },
  { idColumn: "subagent_id", table: "orchestration_v2_projection_subagents" },
  {
    idColumn: "provider_session_id",
    table: "orchestration_v2_projection_provider_sessions",
  },
  {
    idColumn: "provider_thread_id",
    table: "orchestration_v2_projection_provider_threads",
  },
  {
    idColumn: "provider_turn_id",
    table: "orchestration_v2_projection_provider_turns",
  },
  { idColumn: "thread_id", table: "orchestration_v2_projection_threads" },
  {
    idColumn: "context_handoff_id",
    table: "orchestration_v2_projection_context_handoffs",
  },
  {
    idColumn: "context_transfer_id",
    table: "orchestration_v2_projection_context_transfers",
  },
  { idColumn: "checkpoint_id", table: "orchestration_v2_projection_checkpoints" },
  {
    idColumn: "scope_id",
    table: "orchestration_v2_projection_checkpoint_scopes",
  },
  // The V1 tables are still imported into V2 on first open, so they have to be
  // rewritten too or the importer reintroduces the old names.
  { idColumn: "sequence", table: "orchestration_events" },
  { idColumn: "activity_id", table: "projection_thread_activities" },
] as const;

// Free text that records an identity: activity summaries and message bodies.
// Thread titles are prose, so they stay as the user wrote them.
const TEXT_TARGETS = [
  { column: "summary", idColumn: "activity_id", table: "projection_thread_activities" },
  { column: "text", idColumn: "message_id", table: "projection_thread_messages" },
] as const;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  for (const { idColumn, table } of JSON_PAYLOAD_TARGETS) {
    const rows = yield* sql.unsafe<{ id: string; payload: string }>(
      `SELECT ${idColumn} AS id, payload_json AS payload FROM ${table} WHERE payload_json LIKE '%t3%'`,
    );
    for (const row of rows) {
      const payload = rewritePayload(row.payload);
      if (payload === null) continue;
      yield* sql`UPDATE ${sql(table)} SET payload_json = ${payload} WHERE ${sql(idColumn)} = ${row.id}`;
    }
  }

  for (const { column, idColumn, table } of TEXT_TARGETS) {
    const rows = yield* sql.unsafe<{ id: string; text: string }>(
      `SELECT ${idColumn} AS id, ${column} AS text FROM ${table} WHERE ${column} LIKE '%t3%'`,
    );
    for (const row of rows) {
      const text = rewriteText(row.text);
      if (text === null) continue;
      yield* sql`UPDATE ${sql(table)} SET ${sql(column)} = ${text} WHERE ${sql(idColumn)} = ${row.id}`;
    }
  }
});
