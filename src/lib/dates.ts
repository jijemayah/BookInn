/** Calendar dates as 'YYYY-MM-DD' strings, judged in the hotel's time zone. */
export const HOTEL_TZ = "Asia/Manila";

export function hotelToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: HOTEL_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

const toUtc = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));

export function addDays(d: string, n: number): string {
  return new Date(toUtc(d) + n * 86_400_000).toISOString().slice(0, 10);
}

/** Nights between check-in and check-out (half-open stay [in, out)). */
export const nightsBetween = (checkIn: string, checkOut: string) => Math.round((toUtc(checkOut) - toUtc(checkIn)) / 86_400_000);
