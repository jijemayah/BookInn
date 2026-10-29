import type { Db } from "./db/types";
import type { Role } from "./entities";

/** The staff member performing a request; `staffId` null = system job. */
export type Actor = { staffId: number; role: Role };

/**
 * AUDIT_TRAIL rows are written by database triggers (migration 0003). Each
 * write transaction first records who is acting; the setting is
 * transaction-local, so it never leaks to another request on a pooled
 * connection.
 */
export async function setActor(t: Db, actor: { staffId: number | null }) {
  await t.query("SELECT set_config('bookinn.staff_id', $1, true)", [actor.staffId === null ? "" : String(actor.staffId)]);
}
