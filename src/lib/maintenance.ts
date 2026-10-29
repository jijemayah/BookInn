/**
 * Daily maintenance (SRS §3.3 Reservation Completion and Data Retention).
 * The SQL functions live in migration 0003 so they can also be scheduled
 * with Supabase pg_cron; this wrapper is called by /api/cron/maintenance
 * (Vercel Cron) and by the administrator's "Run now" button.
 */
import type { Db } from "./db/types";
import { setActor } from "./audit";
import { hotelToday } from "./dates";

export interface MaintenanceResult {
  today: string;
  completed: number;
  purged: number;
}

export async function runMaintenance(db: Db, opts: { today?: string; staffId?: number | null } = {}): Promise<MaintenanceResult> {
  const today = opts.today ?? hotelToday();
  return db.tx(async (t) => {
    await setActor(t, { staffId: opts.staffId ?? null });
    const c = await t.query<{ n: number }>("SELECT bookinn.complete_reservations($1::date) AS n", [today]);
    const p = await t.query<{ n: number }>("SELECT bookinn.purge_expired_reservations($1::date) AS n", [today]);
    return { today, completed: Number(c.rows[0].n), purged: Number(p.rows[0].n) };
  });
}
