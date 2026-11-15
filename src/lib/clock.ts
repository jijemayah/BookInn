/**
 * Trusted time for BookInn (SRS v2 §3.3 Dates and Times: all dates and times use PHT, UTC+8).
 *
 * The computer running the app may have a wrong clock (a laptop set to 1990 or 2025).
 * BookInn therefore takes the time from the database server, which it is already
 * connected to on every request, and only uses the computer's clock to tick between
 * checks:
 *
 *   - syncClock(db) asks Postgres for clock_timestamp() and remembers the difference
 *     ("offset") from this computer's clock. It re-checks at most once a minute, so it
 *     costs one tiny query per minute, not one per page.
 *   - trustedNow() = this computer's clock + that offset. hotelToday() and hotelNow()
 *     in dates.ts use it, so every booking, cutoff, check-in/out and the daily job do.
 *   - If the database cannot be asked, the last known offset is kept (0 at start, i.e.
 *     the server's own clock, which is reliable on Vercel) and it is tried again soon.
 *     A clock problem never blocks a request.
 *   - If this computer's clock is off by more than 5 minutes, a warning is logged.
 */
import type { Db } from "./db/types";

const RESYNC_MS = 60_000;
const RETRY_AFTER_ERROR_MS = 10_000;
const WARN_MS = 5 * 60_000;

type ClockState = {
  offsetMs: number;
  checkedAt: number;
  synced: boolean;
  pending: Promise<void> | null;
  warned: boolean;
};

// One state per server instance (survives dev hot reloads), like the database pool.
const g = globalThis as unknown as { __bookinnClock?: ClockState };
const state: ClockState = (g.__bookinnClock ??= { offsetMs: 0, checkedAt: 0, synced: false, pending: null, warned: false });

/** The current time, corrected to the database server's clock. */
export function trustedNow(): Date {
  return new Date(Date.now() + state.offsetMs);
}

/** For logs, the admin and tests. */
export function clockStatus() {
  return { offsetMs: state.offsetMs, synced: state.synced, checkedAt: state.checkedAt };
}

/** Makes trustedNow() follow the database clock. Cheap when checked in the last minute; never throws. */
export async function syncClock(db: Db, opts: { force?: boolean } = {}): Promise<void> {
  const local = Date.now();
  if (!opts.force && state.synced && local - state.checkedAt < RESYNC_MS) return;
  if (state.pending) return state.pending; // one check at a time; concurrent requests share it
  state.pending = (async () => {
    try {
      const t0 = Date.now();
      const r = await db.query<{ ms: string }>("SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS ms");
      const t1 = Date.now();
      const dbMs = Number(r.rows[0]?.ms);
      if (!Number.isFinite(dbMs)) throw new Error("database returned no time");
      // The database read the time roughly halfway through the round trip.
      state.offsetMs = Math.round(dbMs - (t0 + t1) / 2);
      state.checkedAt = t1;
      state.synced = true;
      if (Math.abs(state.offsetMs) > WARN_MS && !state.warned) {
        state.warned = true;
        console.warn(
          `[clock] this computer's clock is off by ${describe(state.offsetMs)} compared with the database; BookInn is using the database time.`,
        );
      } else if (Math.abs(state.offsetMs) <= WARN_MS) {
        state.warned = false;
      }
    } catch (err) {
      // Keep the last known offset and try again soon.
      state.checkedAt = Date.now() - RESYNC_MS + RETRY_AFTER_ERROR_MS;
      console.warn(`[clock] could not read the database time (${err instanceof Error ? err.message : String(err)}); using the last known time.`);
    } finally {
      state.pending = null;
    }
  })();
  return state.pending;
}

export interface ClockWarning {
  offsetMs: number;
  /** What this computer's clock says. */
  computerTime: Date;
  /** The time BookInn is using (database time). */
  correctTime: Date;
  /** e.g. "13467 day(s) 11 hour(s) (behind)" */
  difference: string;
}

/**
 * Non-null when this computer's clock differs from the database by more than 5 minutes.
 * Shown as a banner on every page: BookInn keeps working with the correct time, and the
 * banner asks for the computer's clock to be fixed (it also affects secure connections
 * such as email sending).
 */
export function clockWarning(): ClockWarning | null {
  if (!state.synced || Math.abs(state.offsetMs) <= WARN_MS) return null;
  return { offsetMs: state.offsetMs, computerTime: new Date(Date.now()), correctTime: trustedNow(), difference: describe(state.offsetMs) };
}

/** Test helper: forget the offset (as after a server restart). */
export function resetClock() {
  Object.assign(state, { offsetMs: 0, checkedAt: 0, synced: false, pending: null, warned: false });
}

function describe(ms: number) {
  const abs = Math.abs(ms);
  const days = Math.floor(abs / 86_400_000);
  const hours = Math.floor((abs % 86_400_000) / 3_600_000);
  const minutes = Math.round((abs % 3_600_000) / 60_000);
  const text = days > 0 ? `${days} day(s) ${hours} hour(s)` : hours > 0 ? `${hours} hour(s) ${minutes} minute(s)` : `${minutes} minute(s)`;
  return `${text} (${ms > 0 ? "behind" : "ahead"})`;
}
