import * as Scheduler from "../scheduling/Scheduler.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { type ScheduledTaskError, ScheduledTaskUpsertInput } from "@t2code/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const decodeUpsertInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

it.effect("rejects a stale form save after deletion while preserving explicit-id creates", () =>
  Effect.gen(function* () {
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const input = yield* decodeUpsertInput({
        id: "scheduled-task:edit-after-delete",
        title: "Review",
        prompt: "Review the open pull requests.",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: "project-stale-schedule",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const created = yield* service.upsert(input);
      const edit = yield* decodeUpsertInput({ ...input, requireExisting: true, title: "Edited" });
      expect((yield* service.upsert(edit)).task.title).toBe("Edited");
      yield* service.delete({ id: created.task.id });

      const failure = yield* service.upsert(edit).pipe(Effect.flip);
      expect(failure.message).toBe("Schedule task not found.");
      expect((yield* service.list()).tasks).toEqual([]);

      expect((yield* service.upsert(input)).task.id).toBe(created.task.id);
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("preserves a due run when a save only pads the scheduled hour", () =>
  Effect.gen(function* () {
    const dueAt = DateTime.makeZonedUnsafe(
      { year: 2026, month: 7, day: 1, hour: 9, minute: 0, second: 0, millisecond: 0 },
      { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
    );
    yield* TestClock.setTime(DateTime.toEpochMillis(dueAt) - 1_000);

    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const input = yield* decodeUpsertInput({
        commandId: "schedule-time-format",
        title: "Morning review",
        prompt: "Review the open pull requests.",
        enabled: true,
        schedule: { type: "fixed_time", timeOfDay: "9:00" },
        projectId: "project-schedule-time-format",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        creationSource: "mcp",
      });
      const created = yield* service.upsert(input);
      const expectedDueAt = DateTime.formatIso(DateTime.toUtc(dueAt));
      expect(created.task.nextRunAt).toBe(expectedDueAt);

      yield* TestClock.setTime(DateTime.toEpochMillis(dueAt) + 1_000);
      const update = yield* decodeUpsertInput({
        ...input,
        id: created.task.id,
        schedule: { type: "fixed_time", timeOfDay: "09:00" },
      });
      const updated = yield* service.upsert(update);
      expect(updated.task.nextRunAt).toBe(expectedDueAt);
      expect((yield* service.list()).tasks[0]?.nextRunAt).toBe(expectedDueAt);

      const rescheduled = yield* service.upsert({
        ...update,
        schedule: { type: "fixed_time", timeOfDay: "09:30" },
      });
      expect(rescheduled.task.nextRunAt).toBe(
        DateTime.formatIso(DateTime.toUtc(DateTime.add(dueAt, { minutes: 30 }))),
      );
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

const START = Date.parse("2026-07-01T12:00:00.000Z");

function isoAt(epochMillis: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(epochMillis));
}

const onceInput = (at: string) =>
  decodeUpsertInput({
    commandId: "send-later-once",
    title: "Send later",
    prompt: "Ship it.",
    enabled: true,
    schedule: { type: "once", at },
    projectId: "project-once",
    threadId: "thread-once",
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
  });

const runOnceTask = (options: {
  readonly send: (input: unknown) => Effect.Effect<never, never>;
  readonly body: (
    service: ScheduledTaskService.ScheduledTaskService["Service"],
    sent: Deferred.Deferred<void>,
  ) => Effect.Effect<void, ScheduledTaskError | Schema.SchemaError>;
}) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    const sent = yield* Deferred.make<void>();
    yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          Layer.provideMerge(
            ScheduledTaskService.layer,
            Layer.mergeAll(
              Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
              Layer.mock(ThreadManagementService.ThreadManagementService)({
                sendToThread: (input) =>
                  options.send(input).pipe(Effect.ensuring(Deferred.succeed(sent, undefined))),
              }),
              Layer.mock(SecretRequests.SecretRequests)({}),
              NodeCrypto.layer,
              Scheduler.layer,
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const service = yield* ScheduledTaskService.ScheduledTaskService;
          yield* options.body(service, sent);
        }).pipe(Effect.provide(context));
      }),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory));

it.effect("sends a one-time message to its thread once, queued, then keeps the result", () => {
  const calls: Array<Record<string, unknown>> = [];
  return runOnceTask({
    send: (input) => {
      calls.push(input as Record<string, unknown>);
      return Effect.succeed({} as never);
    },
    body: (service, sent) =>
      Effect.gen(function* () {
        const at = isoAt(START + 3_000);
        const created = yield* service.upsert(yield* onceInput(at));
        expect(created.task.nextRunAt).toBe(at);

        yield* TestClock.adjust("6 seconds");
        yield* Deferred.await(sent);
        yield* TestClock.adjust("20 seconds");

        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
          threadId: "thread-once",
          text: "Ship it.",
          mode: "queue",
        });
        const task = (yield* service.list()).tasks[0];
        expect(task).toMatchObject({
          nextRunAt: null,
          runCount: 1,
          lastRunStatus: "succeeded",
          lastRunError: null,
        });

        // Re-enabling a spent one-time task must not resend it.
        yield* service.setEnabled({ id: created.task.id, enabled: false });
        expect(
          (yield* service.setEnabled({ id: created.task.id, enabled: true })).task.nextRunAt,
        ).toBeNull();
      }),
  });
});

it.effect("records a failed one-time send and does not retry it", () => {
  const attempts = { count: 0 };
  return runOnceTask({
    send: () => {
      attempts.count += 1;
      return Effect.die(new Error("thread is archived"));
    },
    body: (service, sent) =>
      Effect.gen(function* () {
        yield* service.upsert(yield* onceInput(isoAt(START + 3_000)));
        yield* TestClock.adjust("6 seconds");
        yield* Deferred.await(sent);
        yield* TestClock.adjust("30 seconds");
        expect(attempts.count).toBe(1);
        const task = (yield* service.list()).tasks[0];
        expect(task).toMatchObject({ nextRunAt: null, runCount: 1, lastRunStatus: "failed" });
        expect(task?.lastRunError).toContain("thread is archived");
      }),
  });
});

it.effect("does not send a one-time message that was deleted before its time", () => {
  const calls = { count: 0 };
  return runOnceTask({
    send: () => {
      calls.count += 1;
      return Effect.succeed({} as never);
    },
    body: (service) =>
      Effect.gen(function* () {
        const created = yield* service.upsert(yield* onceInput(isoAt(START + 3_000)));
        yield* service.delete({ id: created.task.id });
        yield* TestClock.adjust("30 seconds");
        expect(calls.count).toBe(0);
        expect((yield* service.list()).tasks).toEqual([]);
      }),
  });
});

it.effect("reschedules a one-time message when its time is edited", () =>
  runOnceTask({
    send: () => Effect.succeed({} as never),
    body: (service) =>
      Effect.gen(function* () {
        const created = yield* service.upsert(yield* onceInput(isoAt(START + 60_000)));
        const later = isoAt(START + 3_600_000);
        const edited = yield* service.upsert(yield* onceInput(later));
        expect(edited.task.id).toBe(created.task.id);
        expect(edited.task.nextRunAt).toBe(later);
      }),
  }),
);

it.effect("rejects a one-time message scheduled in the past but tolerates clock skew", () =>
  runOnceTask({
    send: () => Effect.succeed({} as never),
    body: (service) =>
      Effect.gen(function* () {
        const stale = yield* onceInput(isoAt(START - 5 * 60_000));
        const rejected = yield* Effect.result(service.upsert(stale));
        expect(Result.isFailure(rejected) ? rejected.failure.message : null).toBe(
          "Pick a time in the future for a one-time task.",
        );
        const skewedInput = yield* onceInput(isoAt(START - 5_000));
        const skewed = yield* service.upsert(skewedInput);
        expect(skewed.task.nextRunAt).toBeNull();
      }),
  }),
);

it.effect("sends an overdue one-time message late after the server was down", () => {
  const calls: Array<Record<string, unknown>> = [];
  return runOnceTask({
    send: (input) => {
      calls.push(input as Record<string, unknown>);
      return Effect.succeed({} as never);
    },
    body: (service, sent) =>
      Effect.gen(function* () {
        yield* service.upsert(yield* onceInput(isoAt(START + 60_000)));
        // Simulate the poll resuming well after `at` (server down in between).
        yield* TestClock.adjust("2 hours");
        yield* Deferred.await(sent);
        expect(calls).toHaveLength(1);
        expect((yield* service.list()).tasks[0]?.lastRunStatus).toBe("succeeded");
      }),
  });
});
