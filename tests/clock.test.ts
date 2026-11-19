/**
 * Trusted time: BookInn takes the date and time from the database server, so a wrong
 * clock on the computer running the app (for example a laptop set to 1990) cannot
 * change reservation dates, cutoffs or check-in times.
 * Only `Date` is faked here (vi.useFakeTimers({ toFake: ["Date"] })), which is what a
 * wrong computer clock looks like to the app.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/types";
import { clockStatus, clockWarning, resetClock, syncClock, trustedNow } from "@/lib/clock";
import { hotelNow, hotelToday } from "@/lib/dates";
import { createBooking, quoteBooking } from "@/lib/booking";
import { checkInRoom } from "@/lib/stay";
import { FRONT_DESK, freshDb } from "./helpers";

const REAL = Date.UTC(2026, 10, 15, 2, 30, 0); // 2026-11-15 10:30 PHT, "the database's time"
const WRONG = Date.UTC(1990, 0, 1, 0, 0, 0); // the computer's clock

/** A database stand-in whose clock is REAL plus however much (fake) time has passed since `start`. */
function fakeDb(start: number, opts: { fail?: boolean } = {}) {
  const calls = { n: 0 };
  const db = {
    calls,
    query: async () => {
      calls.n++;
      if (opts.fail) throw new Error("connection refused");
      return { rows: [{ ms: String(REAL + (Date.now() - start)) }] };
    },
    exec: async () => {},
    tx: async <T,>(fn: (d: Db) => Promise<T>) => fn(db as unknown as Db),
  };
  return db as unknown as Db & { calls: { n: number } };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetClock();
});

describe("trusted clock", () => {
  it("follows the database when the computer's clock says 1990", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(WRONG);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(hotelToday()).toBe("1990-01-01"); // before checking: the computer's clock
    await syncClock(fakeDb(WRONG));
    expect(Math.abs(trustedNow().getTime() - REAL)).toBeLessThan(50);
    expect(hotelToday()).toBe("2026-11-15");
    expect(hotelNow()).toMatch(/^2026-11-15 10:30:/);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("off by"));
    // Time keeps ticking from the corrected value.
    vi.setSystemTime(WRONG + 3 * 3_600_000);
    expect(hotelNow()).toMatch(/^2026-11-15 13:30:/);
  });

  it("checks the database at most once a minute, and shares one check between concurrent requests", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(WRONG);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = fakeDb(WRONG);
    await Promise.all([syncClock(db), syncClock(db), syncClock(db)]);
    expect(db.calls.n).toBe(1);
    vi.setSystemTime(WRONG + 30_000);
    await syncClock(db);
    expect(db.calls.n).toBe(1); // still fresh
    vi.setSystemTime(WRONG + 61_000);
    await syncClock(db);
    expect(db.calls.n).toBe(2);
  });

  it("never blocks a request when the database cannot be asked: it keeps the last known time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(WRONG);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await syncClock(fakeDb(WRONG));
    expect(hotelToday()).toBe("2026-11-15");
    vi.setSystemTime(WRONG + 120_000);
    await expect(syncClock(fakeDb(WRONG, { fail: true }))).resolves.toBeUndefined();
    expect(hotelToday()).toBe("2026-11-15"); // last known offset kept
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not read the database time"));
  });

  it("starts from the server's own clock until the first check, and does not warn when the clocks agree", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(clockStatus()).toMatchObject({ offsetMs: 0, synced: false });
    const now = Date.now();
    await syncClock({ query: async () => ({ rows: [{ ms: String(Date.now()) }] }), exec: async () => {}, tx: async (f) => f({} as Db) } as Db);
    expect(Math.abs(trustedNow().getTime() - now)).toBeLessThan(1_000);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("clock warning banner (shown on every page)", () => {
  it("is shown when the computer's clock is wrong, with both times and the difference", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(WRONG);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(clockWarning()).toBeNull(); // nothing known before the first check
    await syncClock(fakeDb(WRONG));
    const w = clockWarning();
    expect(w).not.toBeNull();
    expect(w!.computerTime.getTime()).toBe(WRONG);
    expect(Math.abs(w!.correctTime.getTime() - REAL)).toBeLessThan(50);
    expect(w!.difference).toBe("13467 day(s) 2 hour(s) (behind)"); // 1 Jan 1990 00:00 UTC → 15 Nov 2026 02:30 UTC
  });

  it("is not shown when the clocks agree, or differ by 5 minutes or less", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(REAL - 4 * 60_000); // computer 4 minutes behind
    await syncClock(fakeDb(REAL - 4 * 60_000));
    expect(clockWarning()).toBeNull();
    resetClock();
    vi.setSystemTime(REAL + 6 * 60_000); // computer 6 minutes ahead
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await syncClock(fakeDb(REAL + 6 * 60_000));
    expect(clockWarning()?.difference).toBe("6 minute(s) (ahead)");
  });

  it("goes away once the computer's clock is fixed (next check)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(WRONG);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await syncClock(fakeDb(WRONG));
    expect(clockWarning()).not.toBeNull();
    vi.setSystemTime(REAL); // someone fixed the clock
    await syncClock({ query: async () => ({ rows: [{ ms: String(REAL) }] }), exec: async () => {}, tx: async (f) => f({} as Db) } as Db, { force: true });
    expect(clockWarning()).toBeNull();
  });
});

describe("bookings and check-in use the database's date, not the computer's", () => {
  let db: Db;
  let close: () => Promise<void>;
  let realNow = 0;
  beforeAll(async () => {
    ({ db, close } = await freshDb());
    realNow = Date.now();
  });
  afterAll(() => close());

  /** The real database, except that its clock reads the real time while the computer's clock is wrong. */
  const withDbClock = (start: number): Db => ({
    query: (sql, params) =>
      sql.includes("clock_timestamp()") ? Promise.resolve({ rows: [{ ms: String(realNow + (Date.now() - start)) }] as never[] }) : db.query(sql, params),
    exec: (sql) => db.exec(sql),
    tx: (fn) => db.tx(fn),
  });

  it("books for today and checks in with today's real date while the computer says 1990", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(WRONG);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const realToday = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date(realNow));
    const tomorrow = new Date(Date.parse(`${realToday}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

    await syncClock(withDbClock(WRONG));
    expect(hotelToday()).toBe(realToday);

    // No "today" is passed: the defaults use the trusted clock.
    const input = { cus_id: "1002", discount_type: "NONE", stays: [{ room_no: "406", check_in_date: realToday, check_out_date: tomorrow }] };
    const q = await quoteBooking(db, FRONT_DESK, input);
    const b = await createBooking(db, FRONT_DESK, { ...input, pay_method: "Cash", pay_amt: (q.dueCents / 100).toFixed(2) });
    const pay = await db.query<{ pay_date: string }>("SELECT pay_date::text FROM bookinn.payment WHERE pay_id = $1", [b.payId]);
    expect(pay.rows[0].pay_date).toBe(realToday); // not 1990-01-01

    const rr = await db.query<{ res_room_id: number }>("SELECT res_room_id FROM bookinn.reservation_room WHERE res_id = $1", [b.resId]);
    const ci = await checkInRoom(db, FRONT_DESK, rr.rows[0].res_room_id);
    expect(ci.checkedInAt.slice(0, 10)).toBe(realToday);
  });
});
