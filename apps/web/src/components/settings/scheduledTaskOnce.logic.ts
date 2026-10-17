import type { ScheduledTask } from "@t2code/contracts";
import {
  defaultSendLaterDate,
  formatSendLaterLabel,
  resolveSendLater,
} from "@t2code/client-runtime/state/send-later";
import { localSnoozeDate, localSnoozeTime } from "@t2code/client-runtime/state/thread-settled";

/** `<input type="datetime-local">` value, in the device's time zone. */
export function onceInputValue(at: string): string {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return "";
  return `${localSnoozeDate(date)}T${localSnoozeTime(date)}`;
}

export function defaultOnceInputValue(now: Date): string {
  return onceInputValue(defaultSendLaterDate(now).toISOString());
}

/**
 * Converts the editor value to an absolute instant. Whether it is in the past
 * is the server's call, so saving an unrelated edit to a sent task still works.
 */
export function onceAtFromInput(value: string): string | null {
  const [date = "", time = ""] = value.split("T");
  const resolved = resolveSendLater({ date, time: time.slice(0, 5) }, new Date(0));
  return resolved.ok ? resolved.at : null;
}

/** A sent one-time task stays listed, so the row has to say what happened to it. */
const LATE_AFTER_MS = 5 * 60_000;

export function onceTaskStatus(task: ScheduledTask, now: Date): string {
  if (task.schedule.type !== "once") return "";
  if (task.lastRunStatus === "running") return "Sending now";
  // Editing the time of a sent task arms it again; the pending run wins over the old result.
  if (task.enabled && task.nextRunAt !== null) {
    return `Sends ${formatSendLaterLabel(task.schedule.at, now)}`;
  }
  if (task.lastRunStatus === "succeeded" || task.lastRunStatus === "failed") {
    const ranAt = task.lastRunAt ?? task.schedule.at;
    const late = Date.parse(ranAt) - Date.parse(task.schedule.at) > LATE_AFTER_MS;
    const label = formatSendLaterLabel(ranAt, now);
    if (task.lastRunStatus === "failed") return `Could not send ${label}`;
    return late ? `Sent late, ${label}` : `Sent ${label}`;
  }
  if (!task.enabled) return `Paused, was set for ${formatSendLaterLabel(task.schedule.at, now)}`;
  return "Not scheduled";
}
