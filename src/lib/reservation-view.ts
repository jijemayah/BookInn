/**
 * Everything the reservation page needs to show the stay and to decide which
 * Front Desk actions are available right now (SRS v2 Table 3 and §3.3). The
 * actions themselves re-check every rule on the server (modify.ts, stay.ts,
 * booking.ts); this only decides what to offer.
 */
import type { Db } from "./db/types";
import type { Actor } from "./audit";
import { DBA, FD } from "./entities";
import { beforeCutoff, cutoffFor, hotelNow, hotelToday } from "./dates";
import { toCents } from "./money";

export type StayRoom = {
  res_room_id: number;
  room_no: number;
  room_type: string;
  room_view: string;
  room_price: string;
  check_in_date: string;
  check_out_date: string;
  actual_check_in: string | null;
  actual_check_out: string | null;
  canCheckIn: boolean;
  canCheckOut: boolean;
  canExtend: boolean;
};

export interface ReservationView {
  resId: number;
  status: string;
  guest: { cus_id: number; cus_name: string; cus_email: string };
  rooms: StayRoom[];
  earliestCheckIn: string | null;
  cutoff: string | null;
  beforeCutoff: boolean;
  paidCents: number;
  pointsSpent: number;
  unpaidCents: number;
  unpaidCount: number;
  settled: boolean;
  roomsCheckedIn: number;
  /** Front Desk or Database Administrator. */
  canAct: boolean;
  canModify: boolean;
  canCancel: boolean;
  canSettle: boolean;
}

export async function reservationView(db: Db, actor: Actor, resId: string | number, now: Date = new Date()): Promise<ReservationView | null> {
  const today = hotelToday(now);
  const nowLocal = hotelNow(now);
  const r = await db.query<{ res_id: number; booking_status: string; cus_id: number; cus_name: string; cus_email: string }>(
    `SELECT r.res_id, r.booking_status::text, c.cus_id, c.cus_name, c.cus_email
       FROM bookinn.reservation r JOIN bookinn.customer c ON c.cus_id = r.cus_id WHERE r.res_id = $1`,
    [resId],
  );
  const res = r.rows[0];
  if (!res) return null;
  const rooms = (
    await db.query<Omit<StayRoom, "canCheckIn" | "canCheckOut" | "canExtend">>(
      `SELECT rr.res_room_id, rr.room_no, d.room_type::text, d.room_view::text, d.room_price::text,
              rr.check_in_date::text, rr.check_out_date::text,
              to_char(rr.actual_check_in, 'YYYY-MM-DD HH24:MI') AS actual_check_in,
              to_char(rr.actual_check_out, 'YYYY-MM-DD HH24:MI') AS actual_check_out
         FROM bookinn.reservation_room rr
         JOIN bookinn.room ro ON ro.room_no = rr.room_no
         JOIN bookinn.room_details d ON d.room_type_id = ro.room_type_id
        WHERE rr.res_id = $1 ORDER BY rr.check_in_date, rr.room_no`,
      [resId],
    )
  ).rows;
  const money = (
    await db.query<{ paid: string; spent: string; unpaid: string; n: number; settled: boolean }>(
      `SELECT (SELECT COALESCE(sum(pay_amt), 0)::text FROM bookinn.payment WHERE res_id = $1) AS paid,
              (SELECT COALESCE(sum(pts_spend), 0)::text FROM bookinn.payment WHERE res_id = $1) AS spent,
              (SELECT COALESCE(sum(charge_amt), 0)::text FROM bookinn.adjustment_charge WHERE res_id = $1 AND pay_status = 'Unpaid') AS unpaid,
              (SELECT count(*)::int FROM bookinn.adjustment_charge WHERE res_id = $1 AND pay_status = 'Unpaid') AS n,
              EXISTS (SELECT 1 FROM bookinn.payment WHERE res_id = $1 AND pay_type = 'Checkout')
                OR EXISTS (SELECT 1 FROM bookinn.refund WHERE res_id = $1 AND refund_type = 'Checkout Credit') AS settled`,
      [resId],
    )
  ).rows[0];

  const canAct = actor.role === FD || actor.role === DBA;
  const status = res.booking_status;
  const earliest = rooms.length ? rooms.map((x) => x.check_in_date).sort()[0] : null;
  const onTime = earliest ? beforeCutoff(nowLocal, earliest) : false;
  const inHouse = rooms.filter((x) => x.actual_check_in && !x.actual_check_out).length;
  const active = status === "Booked" || status === "Checked-In";

  return {
    resId: res.res_id,
    status,
    guest: { cus_id: res.cus_id, cus_name: res.cus_name, cus_email: res.cus_email },
    rooms: rooms.map((x) => ({
      ...x,
      canCheckIn: canAct && active && !x.actual_check_in && today >= x.check_in_date && today < x.check_out_date,
      canCheckOut: canAct && status === "Checked-In" && !!x.actual_check_in && !x.actual_check_out,
      canExtend: canAct && status === "Checked-In" && !!x.actual_check_in && !x.actual_check_out && !money.settled,
    })),
    earliestCheckIn: earliest,
    cutoff: earliest ? cutoffFor(earliest) : null,
    beforeCutoff: onTime,
    paidCents: toCents(money.paid),
    pointsSpent: Number(money.spent),
    unpaidCents: toCents(money.unpaid),
    unpaidCount: Number(money.n),
    settled: Boolean(money.settled),
    roomsCheckedIn: inHouse,
    canAct,
    canModify: canAct && status === "Booked" && onTime,
    canCancel: canAct && status === "Booked",
    canSettle: canAct && status === "Checked-In" && inHouse === 0 && Number(money.n) > 0 && !money.settled,
  };
}

/** Rooms with their type and nightly price, for the edit and extension forms. */
export async function roomChoices(db: Db) {
  const r = await db.query<{ room_no: number; room_type: string; room_view: string; room_price: string }>(
    `SELECT ro.room_no, d.room_type::text, d.room_view::text, d.room_price::text
       FROM bookinn.room ro JOIN bookinn.room_details d ON d.room_type_id = ro.room_type_id ORDER BY ro.room_no`,
  );
  return r.rows;
}
