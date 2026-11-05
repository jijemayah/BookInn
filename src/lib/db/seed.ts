/**
 * Seed data = the SRS v2 §4.2 final 3NF sample tables (docs/SRS_v2.md,
 * Tables 7–19), loaded as written, with these documented differences
 * (docs/SRS_AUDIT.md, section B):
 *   S1  Dates are stored in ISO format (the SRS prints MM-DD-YYYY).
 *   S2  STAFF "[hashed password]" placeholders → real bcrypt hashes.
 *   S3  Test accounts from README.md are kept: JESMEDEL stays active (the SRS
 *       sample shows IS_ACTIVE = No) so the Finance role can be tried; ADMIN
 *       (Database Administrator) and ETEGGERE (second Finance account) are
 *       added. Passwords come from the SEED_* environment variables.
 *   S4  Demo-only reservation 1004 (room 206, 2026-12-20 → 12-22, Booked,
 *       paid by Initial payment 1005: Cash ₱3,000, 30 points earned and not
 *       yet credited) so the screens show an upcoming stay. Not in the SRS.
 * Consistency check of the SRS rows (all kept as is):
 *   - 1001: rooms 205 (3 nights incl. extension) + 206 (2 nights); Initial
 *     6000 = 4 × 1500; Extension 7001 (06-27 → 06-28, 1 × 1500) paid by
 *     Checkout payment 1004; Completed; 5001 = 60 + 15 = 75 points.
 *   - 1002: room 108 (Deluxe 3000), 2 nights paid 6000 − 12% = 5280 with
 *     100 points; edited to 3 nights → Unpaid Modification charge 7002 3000.
 *   - 1003: room 406, 4 × 1500 = 6000; cancelled 10 days before check-in →
 *     Cancellation refund 8001 of 6000; its 60 earned points never credited.
 */
import bcrypt from "bcryptjs";
import type { Db } from "./types";
import { BCRYPT_COST } from "../rules";

export interface SeedPasswords {
  admin: string;
  frontDesk: string;
  finance: string;
  finance2: string;
}

export const SEED_USERNAMES = { admin: "ADMIN", frontDesk: "KDPALVARADO", finance: "JESMEDEL", finance2: "ETEGGERE" } as const;

/** Inserts the sample data once. Returns false (and changes nothing) if staff already exist. */
export async function seed(db: Db, pw: SeedPasswords, cost = BCRYPT_COST): Promise<boolean> {
  const existing = await db.query("SELECT 1 FROM bookinn.staff LIMIT 1");
  if (existing.rows.length) return false; // never overwrite real data

  const [hFd, hFin, hAdm, hFin2] = await Promise.all([
    bcrypt.hash(pw.frontDesk, cost),
    bcrypt.hash(pw.finance, cost),
    bcrypt.hash(pw.admin, cost),
    bcrypt.hash(pw.finance2, cost),
  ]);

  await db.tx(async (t) => {
    // The SRS sample audit rows (Table 19) stand in for the history of this
    // data, so the audit triggers are paused for this transaction only.
    await t.query("SELECT set_config('bookinn.audit_off', 'on', true)");
    await t.query(
      `INSERT INTO bookinn.staff (staff_id, u_name, pass, name, role, is_active) VALUES
         (1001, 'KDPALVARADO', $1, 'Keizzy Dominique Alvarado', 'Front Desk',             'Yes'),
         (1002, 'JESMEDEL',    $2, 'Jody Erich Medel',          'Finance',                'Yes'),
         (1003, 'ADMIN',       $3, 'System Administrator',      'Database Administrator', 'Yes'),
         (1004, 'ETEGGERE',    $4, 'Finance Test Account',      'Finance',                'Yes')`,
      [hFd, hFin, hAdm, hFin2],
    );
    await t.exec(`
      INSERT INTO bookinn.customer (cus_id, cus_name, cus_email, cus_mobile) VALUES
        (1001, 'JUAN DELA CRUZ',  'jdcruz@gmail.com',      '09061234567'),
        (1002, 'KEIZZY ALVARADO', 'kdpalvarado@gmail.com', '09761234567');

      INSERT INTO bookinn.loyalty_acc (lyl_id, cus_id, total_pts) VALUES
        (5001, 1001, 75),
        (5002, 1002, 250);

      INSERT INTO bookinn.room_details (room_type_id, room_type, room_price, room_view) VALUES
        ('RT01', 'Standard', 1500.00, 'Ocean View'),
        ('RT02', 'Deluxe',   3000.00, 'Pool View');

      INSERT INTO bookinn.room (room_no, room_type_id) VALUES
        (205, 'RT01'), (206, 'RT01'), (108, 'RT02'), (406, 'RT01');

      INSERT INTO bookinn.reservation (res_id, cus_id, booking_status) VALUES
        (1001, 1001, 'Completed'),
        (1002, 1002, 'Booked'),
        (1003, 1001, 'Cancelled'),
        (1004, 1001, 'Booked');      -- S4 demo

      INSERT INTO bookinn.reservation_room (res_room_id, res_id, room_no, check_in_date, check_out_date, actual_check_in, actual_check_out) VALUES
        (10001, 1001, 205, '2026-06-25', '2026-06-28', '2026-06-25 14:10', '2026-06-28 11:40'),
        (10002, 1001, 206, '2026-06-25', '2026-06-27', '2026-06-25 14:10', '2026-06-27 11:30'),
        (10003, 1002, 108, '2026-10-08', '2026-10-11', NULL, NULL),
        (10004, 1003, 406, '2026-09-25', '2026-09-29', NULL, NULL),
        (10005, 1004, 206, '2026-12-20', '2026-12-22', NULL, NULL);   -- S4 demo

      INSERT INTO bookinn.payment (pay_id, res_id, pay_type, pay_method, pay_date, pay_amt, pts_earn, pts_spend, discount_type) VALUES
        (1001, 1001, 'Initial',  'Digital Wallet', '2026-06-20', 6000.00, 60, 0,   'NONE'),
        (1002, 1002, 'Initial',  'Cash',           '2026-08-07', 5280.00, 0,  100, '12% Discount'),
        (1003, 1003, 'Initial',  'Digital Wallet', '2026-09-11', 6000.00, 60, 0,   'NONE'),
        (1004, 1001, 'Checkout', 'Cash',           '2026-06-28', 1500.00, 15, 0,   'NONE'),
        (1005, 1004, 'Initial',  'Cash',           '2026-10-20', 3000.00, 30, 0,   'NONE');   -- S4 demo

      INSERT INTO bookinn.receipt (rct_no, pay_id) VALUES
        (1001, 1001), (1002, 1002), (1003, 1003), (1004, 1004), (1005, 1005);

      INSERT INTO bookinn.cancellation (cancel_id, res_id, cancel_date) VALUES
        (9001, 1003, '2026-09-15');

      INSERT INTO bookinn.adjustment_charge (charge_id, res_id, res_room_id, charge_type, ext_from, ext_to, charge_amt, pay_status, pay_id) VALUES
        (7001, 1001, 10001, 'Extension',    '2026-06-27', '2026-06-28', 1500.00, 'Paid',   1004),
        (7002, 1002, NULL,  'Modification', NULL,         NULL,         3000.00, 'Unpaid', NULL);

      INSERT INTO bookinn.refund (refund_id, res_id, refund_type, refund_amt, refund_date) VALUES
        (8001, 1003, 'Cancellation', 6000.00, '2026-09-15');

      INSERT INTO bookinn.audit_trail (audit_id, staff_id, action, aff_tab, rec_id, "timestamp", old_data, new_data) VALUES
        (1001, 1001, 'INSERT', 'ADJUSTMENT_CHARGE', '7001', '2026-06-26 14:05', NULL,          'RES_ID=1001; RES_ROOM_ID=10001; EXT_TO=2026-06-28'),
        (1002, NULL, 'UPDATE', 'LOYALTY_ACC',       '5001', '2026-06-28 11:45', 'TOTAL_PTS=0', 'TOTAL_PTS=75'),
        (1003, 1001, 'INSERT', 'ADJUSTMENT_CHARGE', '7002', '2026-08-07 10:20', NULL,          'RES_ID=1002; CHARGE_AMT=3000'),
        (1004, 1001, 'INSERT', 'CANCELLATION',      '9001', '2026-09-15 09:17', NULL,          'RES_ID=1003'),
        (1005, 1001, 'INSERT', 'REFUND',            '8001', '2026-09-15 09:17', NULL,          'RES_ID=1003; REFUND_AMT=6000');
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
      ["adjustment_charge", "charge_id"],
      ["refund", "refund_id"],
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
