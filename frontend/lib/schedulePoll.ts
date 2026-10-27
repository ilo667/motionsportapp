import type { ScheduleNext } from "@/lib/api";

export const POLL_OPEN_MS = 5_000; // booking window open: seats change fast
export const POLL_IDLE_MAX_MS = 5 * 60_000; // outside the window: safety refresh (missed timers, trainer changes)
export const POLL_ERROR_MS = 30_000;

// Outside the booking window nothing changes except at bookingOpenAt / bookingCloseAt,
// so wake up exactly then (in server time, so a wrong phone clock doesn't matter) or after the safety interval
export function nextPollDelay(data: ScheduleNext | undefined): number {
  if (!data) return POLL_ERROR_MS;
  if (data.bookingWindowOpen) return POLL_OPEN_MS;

  const serverNow = Date.parse(data.serverTime);
  // No group day in the calendar: nothing to wake up for except the safety refresh
  if (!data.bookingOpenAt || !data.bookingCloseAt) return POLL_IDLE_MAX_MS;
  const openAt = Date.parse(data.bookingOpenAt);
  const closeAt = Date.parse(data.bookingCloseAt);
  // Window should be open by now but server still says closed (clock skew) — retry soon
  if (serverNow >= openAt && serverNow < closeAt) return POLL_OPEN_MS;

  const nextEdge = [openAt, closeAt].filter((t) => t > serverNow).sort((a, b) => a - b)[0];
  const untilEdge = nextEdge ? nextEdge - serverNow + 1_000 : POLL_IDLE_MAX_MS;
  return Math.min(Math.max(untilEdge, 1_000), POLL_IDLE_MAX_MS);
}
