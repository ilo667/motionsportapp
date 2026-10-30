import { describe, expect, it } from "vitest";
import type { ScheduleNext } from "@/lib/api";
import { nextPollDelay, POLL_ERROR_MS, POLL_IDLE_MAX_MS, POLL_OPEN_MS } from "@/lib/schedulePoll";

// Booking opens 14:00, closes 20:00 (Kyiv, UTC+2)
function schedule(serverTime: string, over: Partial<ScheduleNext> = {}): ScheduleNext {
  return {
    serverTime,
    bookingWindowOpen: false,
    bookingOpenAt: "2026-10-28T12:00:00.000Z",
    bookingCloseAt: "2026-10-28T18:00:00.000Z",
    ...over,
  } as ScheduleNext;
}

describe("nextPollDelay", () => {
  it("no data (the request failed): retry in 30 s", () => {
    expect(nextPollDelay(undefined)).toBe(POLL_ERROR_MS);
  });

  it("booking open: every 5 s", () => {
    expect(nextPollDelay(schedule("2026-10-28T13:00:00.000Z", { bookingWindowOpen: true }))).toBe(POLL_OPEN_MS);
  });

  it("no group day ahead: only the 5-minute safety refresh", () => {
    expect(nextPollDelay(schedule("2026-10-28T10:00:00.000Z", { bookingOpenAt: null, bookingCloseAt: null }))).toBe(
      POLL_IDLE_MAX_MS,
    );
  });

  it("before the opening: wakes a second after it", () => {
    expect(nextPollDelay(schedule("2026-10-28T11:58:00.000Z"))).toBe(2 * 60_000 + 1_000);
  });

  it("the opening far away: no longer than the safety interval", () => {
    expect(nextPollDelay(schedule("2026-10-28T08:00:00.000Z"))).toBe(POLL_IDLE_MAX_MS);
  });

  it("server says closed inside the window (clock skew): asks again in 5 s", () => {
    expect(nextPollDelay(schedule("2026-10-28T13:00:00.000Z"))).toBe(POLL_OPEN_MS);
  });

  it("after the close: the safety interval", () => {
    expect(nextPollDelay(schedule("2026-10-28T19:00:00.000Z"))).toBe(POLL_IDLE_MAX_MS);
  });

  it("time in server clock, so a phone clock far off changes nothing", () => {
    const realNow = Date.now;
    Date.now = () => 0;
    try {
      expect(nextPollDelay(schedule("2026-10-28T11:59:30.000Z"))).toBe(31_000);
    } finally {
      Date.now = realNow;
    }
  });
});
