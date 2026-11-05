/**
 * Overdue list (SRS v2 FR-28, §3.3 Check-in and Check-out: Overdue).
 * Computed every time it is opened from the database view
 * bookinn.overdue_reservation (migration 0005): a reservation is overdue when
 * its latest check-out date is before today and it is still Checked-In or has
 * an Unpaid charge. Nothing is stored and no job maintains it.
 * Readable by Finance and the Database Administrator only.
 */
import type { Db } from "./db/types";
import type { Actor } from "./audit";
import { setHotelDay } from "./audit";
import { DBA, FIN } from "./entities";
import { AppError } from "./errors";
import { hotelToday } from "./dates";

export type OverdueRow = {
  res_id: number;
  cus_id: number;
  cus_name: string;
  cus_email: string;
  cus_mobile: string;
  booking_status: string;
  latest_check_out: string;
  days_overdue: number;
  rooms_checked_in: number;
  unpaid_charges: number;
  unpaid_amt: string;
};

export function canViewOverdue(actor: Actor) {
  return actor.role === FIN || actor.role === DBA;
}

export async function listOverdue(db: Db, actor: Actor, today: string = hotelToday()): Promise<OverdueRow[]> {
  if (!canViewOverdue(actor)) throw new AppError("forbidden", "The overdue list is available to Finance and the Database Administrator.");
  return db.tx(async (t) => {
    await setHotelDay(t, today);
    const r = await t.query<OverdueRow>(
      `SELECT res_id, cus_id, cus_name, cus_email, cus_mobile, booking_status::text, latest_check_out::text,
              days_overdue, rooms_checked_in, unpaid_charges, unpaid_amt::text
         FROM bookinn.overdue_reservation
        ORDER BY latest_check_out, res_id`,
    );
    return r.rows;
  });
}
