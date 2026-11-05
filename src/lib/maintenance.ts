/**
 * Daily job (SRS v2 §3.3 Scheduled and Automatic Actions). The SQL functions
 * live in migration 0005 so they can also be scheduled with Supabase pg_cron;
 * this wrapper is called by /api/cron/maintenance (Vercel Cron, 00:05
 * Asia/Manila) and by the administrator's "Run now" button.
 *
 * Order, in one transaction: No-Show, Completed, retention purge. After the
 * transaction commits, each guest whose reservation became No-Show gets the
 * No-Show notice by email. An email failure is logged and never undoes or
 * stops the job.
 */
import type { Db } from "./db/types";
import { setActor } from "./audit";
import { hotelToday } from "./dates";
import { sendNoShowNotice, type EmailOutcome } from "./email";

export interface MaintenanceResult {
  today: string;
  /** Reservations set to No-Show. */
  noShows: number[];
  completed: number;
  purged: number;
  /** One No-Show notice per reservation in `noShows`. */
  emails: EmailOutcome[];
}

export async function runMaintenance(db: Db, opts: { today?: string; staffId?: number | null } = {}): Promise<MaintenanceResult> {
  const today = opts.today ?? hotelToday();
  const result = await db.tx(async (t) => {
    await setActor(t, { staffId: opts.staffId ?? null });
    const ns = await t.query<{ res_id: number }>("SELECT res_id FROM bookinn.mark_no_shows($1::date) AS res_id", [today]);
    const c = await t.query<{ n: number }>("SELECT bookinn.complete_reservations($1::date) AS n", [today]);
    const p = await t.query<{ n: number }>("SELECT bookinn.purge_expired_reservations($1::date) AS n", [today]);
    return { today, noShows: ns.rows.map((r) => Number(r.res_id)), completed: Number(c.rows[0].n), purged: Number(p.rows[0].n) };
  });
  const emails: EmailOutcome[] = [];
  for (const resId of result.noShows) emails.push(await sendNoShowNotice(db, resId));
  return { ...result, emails };
}
