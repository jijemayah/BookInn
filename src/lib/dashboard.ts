/** Dashboard figures and room availability, computed from the database (FR-12). */
import type { Db } from "./db/types";
import type { Actor } from "./audit";
import { assertCan } from "./crud";
import { ENTITIES } from "./entities";
import { hotelToday, addDays } from "./dates";
import { toCents } from "./money";

export type RoomAvailability = {
  room_no: number;
  room_type_id: string;
  room_type: string;
  room_view: string;
  room_price: string;
  available: boolean;
  /** Reservation holding the room for part of the range, if any. */
  blocked_by: number | null;
};

/** Rooms free for the whole stay [from, to): no Booked reservation overlaps. */
export async function roomAvailability(db: Db, actor: Actor, from: string, to: string): Promise<RoomAvailability[]> {
  assertCan(actor, ENTITIES.room, "read");
  const r = await db.query<RoomAvailability>(
    `SELECT ro.room_no, ro.room_type_id, d.room_type::text, d.room_view::text, d.room_price::text,
            b.res_id IS NULL AS available, b.res_id AS blocked_by
       FROM bookinn.room ro
       JOIN bookinn.room_details d ON d.room_type_id = ro.room_type_id
       LEFT JOIN LATERAL (
            SELECT rr.res_id FROM bookinn.reservation_room rr
              JOIN bookinn.reservation r ON r.res_id = rr.res_id
             WHERE rr.room_no = ro.room_no AND r.booking_status = 'Booked'
               AND rr.check_in_date < $2::date AND rr.check_out_date > $1::date
             LIMIT 1) b ON true
      ORDER BY ro.room_no`,
    [from, to],
  );
  return r.rows;
}

export interface DashboardStats {
  today: string;
  customers: number;
  rooms: number;
  availableTonight: number;
  inHouse: number;
  upcoming: number;
  booked: number;
  completed: number;
  cancelled: number;
  payments: number;
  revenueCents: number;
  revenueThisMonthCents: number;
  loyaltyAccounts: number;
  loyaltyPoints: number;
  nextArrivals: { res_id: number; cus_name: string; room_no: number; check_in_date: string; check_out_date: string }[];
}

export async function dashboardStats(db: Db, actor: Actor, today = hotelToday()): Promise<DashboardStats> {
  assertCan(actor, ENTITIES.reservation, "read");
  const one = async (sql: string, params: unknown[] = []) => (await db.query<{ v: string | null }>(sql, params)).rows[0].v;
  const monthStart = `${today.slice(0, 7)}-01`;
  const [customers, rooms, inHouse, upcoming, statuses, pay, payMonth, loyalty, arrivals, avail] = await Promise.all([
    one("SELECT count(*)::text AS v FROM bookinn.customer"),
    one("SELECT count(*)::text AS v FROM bookinn.room"),
    one(
      `SELECT count(DISTINCT r.res_id)::text AS v FROM bookinn.reservation r JOIN bookinn.reservation_room rr ON rr.res_id = r.res_id
        WHERE r.booking_status = 'Booked' AND rr.check_in_date <= $1::date AND rr.check_out_date > $1::date`,
      [today],
    ),
    one(
      `SELECT count(*)::text AS v FROM bookinn.reservation r
        WHERE r.booking_status = 'Booked' AND (SELECT min(check_in_date) FROM bookinn.reservation_room WHERE res_id = r.res_id) > $1::date`,
      [today],
    ),
    db.query<{ booking_status: string; n: number }>(
      "SELECT booking_status::text, count(*)::int AS n FROM bookinn.reservation GROUP BY 1",
    ),
    db.query<{ n: number; total: string }>("SELECT count(*)::int AS n, COALESCE(sum(pay_amt), 0)::text AS total FROM bookinn.payment"),
    one("SELECT COALESCE(sum(pay_amt), 0)::text AS v FROM bookinn.payment WHERE pay_date >= $1::date AND pay_date <= $2::date", [
      monthStart,
      today,
    ]),
    db.query<{ n: number; pts: number }>("SELECT count(*)::int AS n, COALESCE(sum(total_pts), 0)::int AS pts FROM bookinn.loyalty_acc"),
    db.query<DashboardStats["nextArrivals"][number]>(
      `SELECT r.res_id, c.cus_name, rr.room_no, rr.check_in_date, rr.check_out_date
         FROM bookinn.reservation r
         JOIN bookinn.customer c ON c.cus_id = r.cus_id
         JOIN bookinn.reservation_room rr ON rr.res_id = r.res_id
        WHERE r.booking_status = 'Booked' AND rr.check_out_date > $1::date
        ORDER BY rr.check_in_date, rr.room_no LIMIT 8`,
      [today],
    ),
    roomAvailability(db, actor, today, addDays(today, 1)),
  ]);
  const byStatus = Object.fromEntries(statuses.rows.map((s) => [s.booking_status, Number(s.n)]));
  return {
    today,
    customers: Number(customers),
    rooms: Number(rooms),
    availableTonight: avail.filter((a) => a.available).length,
    inHouse: Number(inHouse),
    upcoming: Number(upcoming),
    booked: byStatus.Booked ?? 0,
    completed: byStatus.Completed ?? 0,
    cancelled: byStatus.Cancelled ?? 0,
    payments: Number(pay.rows[0].n),
    revenueCents: toCents(pay.rows[0].total),
    revenueThisMonthCents: toCents(payMonth ?? "0"),
    loyaltyAccounts: Number(loyalty.rows[0].n),
    loyaltyPoints: Number(loyalty.rows[0].pts),
    nextArrivals: arrivals.rows,
  };
}
