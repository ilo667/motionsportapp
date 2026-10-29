import { describe, expect, it } from "vitest";
import { ddmm, kyivDateTime, kyivToday, longDay, shortDay } from "@/lib/dates";

describe("kyivToday", () => {
  it("the Kyiv date, not the browser's, around midnight", () => {
    // 23:30 UTC = 01:30 in Kyiv (winter), already the next day there
    expect(kyivToday(new Date("2026-12-20T23:30:00Z"))).toBe("2026-12-21");
    // 21:30 UTC = 00:30 in Kyiv (summer)
    expect(kyivToday(new Date("2026-07-10T21:30:00Z"))).toBe("2026-07-11");
    expect(kyivToday(new Date("2026-07-10T20:30:00Z"))).toBe("2026-07-10");
  });

  it("the same whatever the browser's time zone", () => {
    const realTz = process.env.TZ;
    try {
      for (const tz of ["Pacific/Honolulu", "Pacific/Kiritimati", "Europe/Kyiv"]) {
        process.env.TZ = tz;
        expect(kyivToday(new Date("2026-12-20T23:30:00Z"))).toBe("2026-12-21");
      }
    } finally {
      process.env.TZ = realTz;
    }
  });
});

describe("ddmm", () => {
  it("«27.10» from a date or an ISO time", () => {
    expect(ddmm("2026-10-27")).toBe("27.10");
    expect(ddmm("2026-01-05")).toBe("05.01");
    expect(ddmm("2026-10-27T21:30:00.000Z")).toBe("27.10");
  });
});

describe("longDay / shortDay", () => {
  it("weekday and month in words", () => {
    expect(longDay("2026-10-26")).toBe("понеділок, 26 жовтня");
    expect(shortDay("2026-10-27")).toBe("27 жовт.");
  });

  it("the same date whatever the browser's time zone", () => {
    const realTz = process.env.TZ;
    try {
      for (const tz of ["Pacific/Honolulu", "Pacific/Kiritimati", "Europe/Kyiv"]) {
        process.env.TZ = tz;
        expect(longDay("2026-10-26")).toBe("понеділок, 26 жовтня");
        expect(shortDay("2026-12-31")).toBe("31 груд.");
      }
    } finally {
      process.env.TZ = realTz;
    }
  });
});

describe("kyivDateTime", () => {
  it("a moment in Kyiv time, summer and winter", () => {
    expect(kyivDateTime("2026-10-20T12:02:00.000Z")).toBe("20 жовт., 15:02");
    expect(kyivDateTime("2026-12-20T22:30:00.000Z")).toBe("21 груд., 00:30");
  });
});
