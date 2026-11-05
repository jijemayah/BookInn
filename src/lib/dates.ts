/**
 * Calendar dates as 'YYYY-MM-DD' strings and times as 'YYYY-MM-DD HH:MM:SS'
 * strings, judged in the hotel's time zone (SRS v2 §3.3 Dates and Times:
 * all dates and times use Asia/Manila; check-in 14:00, check-out 12:00).
 * Manila has no daylight saving time, so string comparison is safe.
 */
export const HOTEL_TZ = "Asia/Manila";
export const CHECK_IN_TIME = "14:00:00";
export const CHECK_OUT_TIME = "12:00:00";

const parts = (now: Date) =>
  Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: HOTEL_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );

export function hotelToday(now: Date = new Date()): string {
  const p = parts(now);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Current hotel time, e.g. '2026-06-25 14:10:00' (stored in ACTUAL_CHECK_IN / ACTUAL_CHECK_OUT). */
export function hotelNow(now: Date = new Date()): string {
  const p = parts(now);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/** A hotel-time string as a Date (for tests and callers that pass "now"). */
export const atHotelTime = (local: string) => new Date(`${local.replace(" ", "T")}${local.length === 10 ? "T00:00:00" : ""}+08:00`);

const toUtc = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));

export function addDays(d: string, n: number): string {
  return new Date(toUtc(d) + n * 86_400_000).toISOString().slice(0, 10);
}

/** Nights between check-in and check-out (half-open stay [in, out)). */
export const nightsBetween = (checkIn: string, checkOut: string) => Math.round((toUtc(checkOut) - toUtc(checkIn)) / 86_400_000);

/** The 48-hour cutoff: the earliest check-in date at 14:00 minus 48 hours (SRS v2 §3.3). */
export const cutoffFor = (earliestCheckIn: string) => `${addDays(earliestCheckIn, -2)} ${CHECK_IN_TIME}`;

/** True when an action at hotel time `nowLocal` is on time; exactly at the cutoff still counts. */
export const beforeCutoff = (nowLocal: string, earliestCheckIn: string) => nowLocal <= cutoffFor(earliestCheckIn);
