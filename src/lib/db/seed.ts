/**
 * Seed data = the SRS §4.2 3NF sample tables, corrected so every row obeys
 * the SRS business rules (see docs/SRS_AUDIT.md item A21 and the README):
 *   C1  Dates normalised to ISO (sample mixes "06-25-2026" and "9-25-2026").
 *   C2  LOYALTY_ACC 5001: customer 1001 earned 120 pts on payment 1001 and
 *       120 pts on payment 1003 (points stay final after cancellation), so
 *       the balance is 240 before the demo booking below (the 3NF table shows 120).
 *   C3  RESERVATION 1001 and 1002 "Booked" → "Completed": both stays ended
 *       before the SRS date, and the system marks finished stays Completed.
 *   C4  STAFF "[HashedPass]" placeholders → real bcrypt hashes; an initial
 *       Database Administrator account is added (the sample has none).
 *       JESMEDEL (Finance) is seeded active so the Finance role can be tried.
 *   C5  Sample audit row 1001 is attributed to Front Desk (1001): Finance is
 *       read-only in the revised SRS. Audit row 1002 no longer mentions the
 *       removed CANCELLED_BY column.
 *   D1  Demo-only extra booking 1004 (future stay, room 206, Cash ₱3000,
 *       +60 pts → account 5001 = 300) so the dashboard shows an upcoming stay.
 * Verified consistent and kept: payment amounts (6000 = 2 rooms × 2 nights ×
 * 1500; 5280 = 6000 − 12%; 6000 = 4 nights × 1500), points (6000 / 50 = 120;
 * a 12% discount spends 100 pts and earns 0), receipts 1:1 with payments, and
 * cancellation 9001 → reservation 1003.
 */
import bcrypt from "bcryptjs";
import type { Db } from "./types";
import { BCRYPT_COST } from "../rules";

export interface SeedPasswords {
  admin: string;
  frontDesk: string;
  finance: string;
}

export const SEED_USERNAMES = { admin: "ADMIN", frontDesk: "KDPALVARADO", finance: "JESMEDEL" } as const;

/** Inserts the sample data once. Returns false (and changes nothing) if staff already exist. */
export async function seed(db: Db, pw: SeedPasswords, cost = BCRYPT_COST): Promise<boolean> {
  const existing = await db.query("SELECT 1 FROM bookinn.staff LIMIT 1");
  if (existing.rows.length) return false; // never overwrite real data

  const [hFd, hFin, hAdm] = await Promise.all([
    bcrypt.hash(pw.frontDesk, cost),
    bcrypt.hash(pw.finance, cost),
    bcrypt.hash(pw.admin, cost),
  ]);

  await db.tx(async (t) => {
    // The two SRS sample audit rows below stand in for the history of this data,
    // so the audit triggers are paused for this transaction only.
    await t.query("SELECT set_config('bookinn.audit_off', 'on', true)");
    await t.query(
      `INSERT INTO bookinn.staff (staff_id, u_name, pass, name, role, is_active) VALUES
         (1001, 'KDPALVARADO', $1, 'Keizzy Dominique Alvarado', 'Front Desk',             'Yes'),
         (1002, 'JESMEDEL',    $2, 'Jody Erich Medel',          'Finance',                'Yes'),
         (1003, 'ADMIN',       $3, 'System Administrator',      'Database Administrator', 'Yes')`,
      [hFd, hFin, hAdm],
    );
    await t.exec(`
      INSERT INTO bookinn.customer (cus_id, cus_name, cus_email, cus_mobile) VALUES
        (1001, 'JUAN DELA CRUZ',  'jdcruz@gmail.com',      '09061234567'),
        (1002, 'KEIZZY ALVARADO', 'kdpalvarado@gmail.com', '09761234567');

      INSERT INTO bookinn.loyalty_acc (lyl_id, cus_id, total_pts) VALUES
        (5001, 1001, 300),   -- C2 240 + D1 60
        (5002, 1002, 250);

      INSERT INTO bookinn.room_details (room_type_id, room_type, room_price, room_view) VALUES
        ('RT01', 'Standard', 1500.00, 'Ocean View'),
        ('RT02', 'Deluxe',   3000.00, 'Pool View');

      INSERT INTO bookinn.room (room_no, room_type_id) VALUES
        (205, 'RT01'), (206, 'RT01'), (108, 'RT02'), (406, 'RT01');

      INSERT INTO bookinn.reservation (res_id, cus_id, booking_status) VALUES
        (1001, 1001, 'Completed'),  -- C3
        (1002, 1002, 'Completed'),  -- C3
        (1003, 1001, 'Cancelled'),
        (1004, 1001, 'Booked');     -- D1

      INSERT INTO bookinn.reservation_room (res_room_id, res_id, room_no, check_in_date, check_out_date) VALUES
        (10001, 1001, 205, '2026-06-25', '2026-06-27'),
        (10002, 1001, 206, '2026-06-25', '2026-06-27'),
        (10003, 1002, 108, '2026-08-08', '2026-08-10'),
        (10004, 1003, 406, '2026-09-25', '2026-09-29'),
        (10005, 1004, 206, '2026-12-20', '2026-12-22');

      INSERT INTO bookinn.payment (pay_id, res_id, pay_method, pay_date, pay_amt, pts_earn, pts_spend, discount_type) VALUES
        (1001, 1001, 'Digital Wallet', '2026-06-20', 6000.00, 120, 0,   'NONE'),
        (1002, 1002, 'Cash',           '2026-08-07', 5280.00, 0,   100, '12% Discount'),
        (1003, 1003, 'Digital Wallet', '2026-09-11', 6000.00, 120, 0,   'NONE'),
        (1004, 1004, 'Cash',           '2026-10-20', 3000.00, 60,  0,   'NONE');

      INSERT INTO bookinn.receipt (rct_no, pay_id) VALUES (1001, 1001), (1002, 1002), (1003, 1003), (1004, 1004);

      INSERT INTO bookinn.cancellation (cancel_id, res_id, cancel_date) VALUES
        (9001, 1003, '2026-09-15');

      INSERT INTO bookinn.audit_trail (audit_id, staff_id, action, aff_tab, rec_id, "timestamp", old_data, new_data) VALUES
        (1001, 1001, 'UPDATE', 'LOYALTY_ACC',  '5001', '2026-06-20 10:49', 'TOTAL_PTS=0', 'TOTAL_PTS=120'),
        (1002, 1001, 'INSERT', 'CANCELLATION', '9001', '2026-09-15 09:17', NULL, 'RES_ID=1003; CANCEL_DATE=2026-09-15');
    `);

    // Explicit IDs were inserted, so move each identity sequence past them.
    for (const [table, col] of [
      ["staff", "staff_id"],
      ["customer", "cus_id"],
      ["loyalty_acc", "lyl_id"],
      ["reservation", "res_id"],
      ["reservation_room", "res_room_id"],
      ["payment", "pay_id"],
      ["receipt", "rct_no"],
      ["cancellation", "cancel_id"],
      ["audit_trail", "audit_id"],
    ]) {
      await t.query(
        `SELECT setval(pg_get_serial_sequence('bookinn.${table}', '${col}'), (SELECT max(${col}) FROM bookinn.${table}))`,
      );
    }
    await t.query("SELECT set_config('bookinn.audit_off', '', true)");
  });
  return true;
}
