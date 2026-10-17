// @effect-diagnostics globalDate:off -- Send-later input is a local calendar date and wall-clock time.
import { localSnoozeDate, localSnoozeTime } from "./threadSettled.ts";

export type SendLaterInput = { readonly date: string; readonly time: string };

export type SendLaterResolution =
  | { readonly ok: true; readonly at: string }
  | { readonly ok: false; readonly reason: "invalid" | "past" };

export const SEND_LATER_ERROR_MESSAGES = {
  invalid: "Choose a valid date and time.",
  past: "Choose a time in the future.",
} as const satisfies Record<Extract<SendLaterResolution, { ok: false }>["reason"], string>;

/**
 * Interprets the picked date and time in the device's time zone and returns the
 * absolute UTC instant. The server stores that instant, so the send time does
 * not shift if the environment runs in a different zone than the client.
 */
export function resolveSendLater(input: SendLaterInput, now: Date): SendLaterResolution {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !/^\d{2}:\d{2}$/.test(input.time)) {
    return { ok: false, reason: "invalid" };
  }
  const at = new Date(`${input.date}T${input.time}:00`);
  // Reject rolled-over dates and nonexistent local times during DST changes.
  if (
    !Number.isFinite(at.getTime()) ||
    localSnoozeDate(at) !== input.date ||
    localSnoozeTime(at) !== input.time
  ) {
    return { ok: false, reason: "invalid" };
  }
  return at.getTime() > now.getTime()
    ? { ok: true, at: at.toISOString() }
    : { ok: false, reason: "past" };
}

/** The next top of the hour, which is what a user most often means by "later". */
export function defaultSendLaterDate(now: Date): Date {
  const next = new Date(now);
  next.setMinutes(0, 0, 0);
  next.setHours(next.getHours() + 1);
  return next;
}

/**
 * Label for the confirmation toast and list rows. The zone is always shown
 * because a remote environment may sit in a different zone than this device.
 */
export function formatSendLaterLabel(at: string, now: Date, timeZone?: string): string {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return at;
  const zone = timeZone === undefined ? {} : { timeZone };
  const sameDay =
    new Intl.DateTimeFormat(undefined, { ...zone, dateStyle: "short" }).format(date) ===
    new Intl.DateTimeFormat(undefined, { ...zone, dateStyle: "short" }).format(now);
  const within6Days = Math.abs(date.getTime() - now.getTime()) < 6 * 24 * 3_600_000;
  const day = sameDay
    ? ""
    : new Intl.DateTimeFormat(undefined, {
        ...zone,
        ...(within6Days ? { weekday: "short" } : { month: "short", day: "numeric" }),
      }).format(date);
  const time = new Intl.DateTimeFormat(undefined, {
    ...zone,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
  return day === "" ? time : `${day} ${time}`;
}
