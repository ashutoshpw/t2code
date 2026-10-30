import * as NodeSqliteClient from "@t2code/shared/nodeSqliteClient";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import { rewriteLegacyMcpIdentity } from "./074_LegacyMcpIdentityRewrite.ts";

const NOW = "2026-01-01T00:00:00.000Z";

it("rewrites recorded MCP identities and leaves everything else alone", () => {
  const rewritten = [
    ["mcp__t3-code__t3_thread_send", "mcp__t2-code__t2_thread_send"],
    ["mcp__t3_code__t2_thread_send", "mcp__t2-code__t2_thread_send"],
    ["mcp__t3code__delegate_task", "mcp__t2-code__delegate_task"],
    ["mcp_t3-code_delegate_task", "mcp_t2-code_delegate_task"],
    ["T3-code.delegate_task", "t2-code.delegate_task"],
    ["t3_code:delegate_task", "t2-code:delegate_task"],
    ["t3-code__delegate_task", "t2-code__delegate_task"],
    ["t3-code/delegate_task", "t2-code/delegate_task"],
    ["t3-code delegate_task", "t2-code delegate_task"],
    [
      "t3-code-thread_opencode2-adapter_t2_thread_read",
      "t2-code-thread_opencode2-adapter_t2_thread_read",
    ],
    ["delegate_task_t3-code", "delegate_task_t2-code"],
    ["delegate_task (t3-code MCP Server)", "delegate_task (t2-code MCP Server)"],
    [
      'task_status (t3-code MCP Server): {"taskId":"node:1"}',
      'task_status (t2-code MCP Server): {"taskId":"node:1"}',
    ],
    ["t3_thread_send", "t2_thread_send"],
    ["t3-code", "t2-code"],
    ["t3_code", "t2-code"],
    ["t3code", "t2-code"],
    [
      "See [the thread](t3-thread://v1/thread/abc?message=m1).",
      "See [the thread](t2-thread://v1/thread/abc?message=m1).",
    ],
  ] as const;

  for (const [input, expected] of rewritten) {
    assert.equal(rewriteLegacyMcpIdentity(input), expected, input);
  }

  const untouched = [
    "/home/dev/t3code/apps/server",
    "Checkout pingdotgg/t3code and rebrand it.",
    "The t3code repository keeps its own history.",
    "https://github.com/t3code/t3code",
    "mcp__github__search_issues",
    "t2-code.t2_thread_send",
    "mcp__t2-code__t2_thread_send",
    "Read a T2 thread",
  ] as const;

  for (const value of untouched) {
    assert.equal(rewriteLegacyMcpIdentity(value), value, value);
  }
});

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("074_LegacyMcpIdentityRewrite", (it) => {
  it.effect("rewrites stored transcripts recorded under the old names", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 62 });

      yield* sql`
          INSERT INTO orchestration_v2_events (
            event_id, thread_id, event_type, occurred_at, payload_json
          ) VALUES (
            'event-legacy', 'thread-1', 'item.updated', ${NOW},
            '{"toolName":"mcp__t3-code__t3_thread_send","serverName":"t3-code"}'
          ), (
            'event-modern', 'thread-1', 'item.updated', ${NOW},
            '{"toolName":"mcp__t2-code__t2_thread_send","serverName":"t2-code"}'
          )
        `;

      yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            'item-legacy', 'thread-1', 1, 'dynamic_tool', 'completed', ${NOW},
            '{"title":"delegate_task (t3-code MCP Server)","toolName":"T3-code.delegate_task"}'
          ), (
            'item-prose', 'thread-1', 2, 'user_message', 'completed', ${NOW},
            '{"text":"I cloned /home/dev/t3code and filed it under t3code."}'
          )
        `;

      yield* sql`
          INSERT INTO orchestration_v2_projection_messages (
            message_id, thread_id, role, streaming, created_at, updated_at, payload_json
          ) VALUES (
            'message-legacy', 'thread-1', 'user', 0, ${NOW}, ${NOW},
            '{"markdown":"Open [it](t3-thread://v1/thread/thread-1?message=m1)."}'
          )
        `;

      yield* sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type,
            occurred_at, actor_kind, payload_json, metadata_json
          ) VALUES (
            'legacy-event', 'thread', 'thread-1', 1, 'item.updated', ${NOW}, 'agent',
            '{"toolName":"t3_thread_send","serverName":"t3_code"}', '{}'
          )
        `;

      yield* sql`
          INSERT INTO projection_thread_messages (
            message_id, thread_id, role, text, is_streaming, created_at, updated_at
          ) VALUES (
            'legacy-message', 'thread-1', 'user',
            'See [the thread](t3-thread://v1/thread/thread-1).', 0, ${NOW}, ${NOW}
          )
        `;

      yield* runMigrations();

      const events = yield* sql<{ readonly eventId: string; readonly payload: string }>`
          SELECT event_id AS "eventId", payload_json AS payload FROM orchestration_v2_events ORDER BY event_id
        `;
      assert.deepEqual(events, [
        {
          eventId: "event-legacy",
          payload: '{"toolName":"mcp__t2-code__t2_thread_send","serverName":"t2-code"}',
        },
        {
          eventId: "event-modern",
          payload: '{"toolName":"mcp__t2-code__t2_thread_send","serverName":"t2-code"}',
        },
      ]);

      const items = yield* sql<{ readonly payload: string; readonly turnItemId: string }>`
          SELECT turn_item_id AS "turnItemId", payload_json AS payload
          FROM orchestration_v2_projection_turn_items ORDER BY ordinal
        `;
      assert.deepEqual(items, [
        {
          turnItemId: "item-legacy",
          payload:
            '{"title":"delegate_task (t2-code MCP Server)","toolName":"t2-code.delegate_task"}',
        },
        {
          turnItemId: "item-prose",
          payload: '{"text":"I cloned /home/dev/t3code and filed it under t3code."}',
        },
      ]);

      const messages = yield* sql<{ readonly payload: string }>`
          SELECT payload_json AS payload FROM orchestration_v2_projection_messages
        `;
      assert.deepEqual(messages, [
        { payload: '{"markdown":"Open [it](t2-thread://v1/thread/thread-1?message=m1)."}' },
      ]);

      const legacyEvents = yield* sql<{ readonly payload: string }>`
          SELECT payload_json AS payload FROM orchestration_events
        `;
      assert.deepEqual(legacyEvents, [
        { payload: '{"toolName":"t2_thread_send","serverName":"t2-code"}' },
      ]);

      const legacyMessages = yield* sql<{ readonly text: string }>`
          SELECT text FROM projection_thread_messages
        `;
      assert.deepEqual(legacyMessages, [
        { text: "See [the thread](t2-thread://v1/thread/thread-1)." },
      ]);
    }),
  );
});
