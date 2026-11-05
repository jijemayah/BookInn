/**
 * Stage 3: emails through Resend (mocked: nothing is sent), the overdue list,
 * and the daily-job endpoint.
 *   - receipt for every payment (Initial and Checkout), to the guest's email
 *   - refund confirmation for every refund (Cancellation and Checkout Credit)
 *   - No-Show notice right after the daily job sets No-Show
 *   - email failures never roll back or break the flow; sent after commit
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/types";

const send = vi.hoisted(() => vi.fn());
vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(function (this: unknown) {
    return { emails: { send } };
  }),
}));

// The cron route uses the app's database connection; point it at the test database.
const dbRef = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db/pg", () => ({ getDb: () => dbRef.db }));

import { cancelReservation, createBooking, quoteBooking, type BookingInput } from "@/lib/booking";
import { createRow } from "@/lib/crud";
import { modifyReservation } from "@/lib/modify";
import { checkInRoom, checkOutRoom, extendStay, settleCheckout } from "@/lib/stay";
import { runMaintenance } from "@/lib/maintenance";
import { listOverdue } from "@/lib/overdue";
import { buildNoShowNotice, buildReceipt, buildRefundConfirmation, sendReceipt } from "@/lib/email";
import { atHotelTime } from "@/lib/dates";
import { GET as cronGET } from "@/app/api/cron/maintenance/route";
import { ADMIN, FINANCE, FRONT_DESK, TODAY, count, freshDb } from "./helpers";

let db: Db;
let close: () => Promise<void>;
const KEY = "re_test_not_a_real_key_0000000000";

beforeAll(async () => {
  ({ db, close } = await freshDb());
  dbRef.db = db;
  process.env.RESEND_API_KEY = KEY;
  process.env.RESEND_FROM_EMAIL = "BookInn <bookings@example.test>";
  process.env.CRON_SECRET = "cron-secret-for-tests-0123456789";
});
afterAll(async () => {
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM_EMAIL;
  delete process.env.CRON_SECRET;
  await close();
});
beforeEach(() => {
  send.mockReset();
  send.mockResolvedValue({ data: { id: "email_123" }, error: null, headers: null });
});

const at = (s: string) => atHotelTime(s);
const stay = (room_no: string, check_in_date: string, check_out_date: string) => ({ room_no, check_in_date, check_out_date });
async function book(input: Omit<BookingInput, "pay_amt" | "pay_method">, day = TODAY) {
  const q = await quoteBooking(db, FRONT_DESK, input, day);
  return createBooking(db, FRONT_DESK, { ...input, pay_method: "Cash", pay_amt: (q.dueCents / 100).toFixed(2) }, day);
}
const sent = () => send.mock.calls.map(([mail, opts]) => ({ ...mail, idempotencyKey: opts?.idempotencyKey }));
const roomRow = async (resId: number) =>
  Number((await db.query<{ id: number }>("SELECT res_room_id AS id FROM bookinn.reservation_room WHERE res_id = $1", [resId])).rows[0].id);

describe("receipts: one per payment, to the guest", () => {
  it("emails the Initial payment receipt after the booking is saved", async () => {
    const b = await book({ cus_id: "1002", discount_type: "NONE", stays: [stay("205", "2027-01-10", "2027-01-12")] });
    expect(send).toHaveBeenCalledTimes(1);
    const [m] = sent();
    expect(m).toMatchObject({
      from: "BookInn <bookings@example.test>",
      to: ["kdpalvarado@gmail.com"],
      subject: `BookInn receipt #${b.rctNo} for reservation #${b.resId}`,
      idempotencyKey: `bookinn-receipt-${b.payId}`,
    });
    expect(m.text).toContain("Amount paid: ₱3,000.00");
    expect(m.text).toContain("Room 205 (Standard), 2027-01-10 to 2027-01-12");
    expect(m.html).toContain("Receipt number");
    expect(b.emails).toEqual([expect.objectContaining({ kind: "receipt", status: "sent", to: "kdpalvarado@gmail.com" })]);
  });

  it("emails the Checkout payment receipt listing the charges it settled", async () => {
    const b = await book({ cus_id: "1001", discount_type: "NONE", stays: [stay("406", "2027-02-10", "2027-02-11")] }, "2027-02-01");
    const r = await roomRow(b.resId);
    await checkInRoom(db, FRONT_DESK, r, at("2027-02-10 14:00:00"));
    await extendStay(db, FRONT_DESK, r, "2027-02-12", {}, at("2027-02-10 18:00:00"));
    await checkOutRoom(db, FRONT_DESK, r, at("2027-02-12 11:00:00"));
    send.mockClear();
    const s = await settleCheckout(db, FRONT_DESK, b.resId, { pay_method: "Card", pay_amt: "1500" }, at("2027-02-12 11:05:00"));
    expect(sent()).toEqual([
      expect.objectContaining({ to: ["jdcruz@gmail.com"], idempotencyKey: `bookinn-receipt-${s.payId}` }),
    ]);
    expect(sent()[0].text).toMatch(/Extension charge #\d+ \(2027-02-11 to 2027-02-12\): ₱1,500\.00/);
    expect(sent()[0].text).toContain("check-out payment");
  });

  it("emails a receipt for a payment the administrator records on the generic form", async () => {
    const r = await db.query<{ res_id: number }>("INSERT INTO bookinn.reservation (cus_id) VALUES (1002) RETURNING res_id");
    await db.query("INSERT INTO bookinn.reservation_room (res_id, room_no, check_in_date, check_out_date) VALUES ($1, 108, '2027-03-01', '2027-03-02')", [r.rows[0].res_id]);
    const p = await createRow(db, ADMIN, "payment", { res_id: String(r.rows[0].res_id), pay_type: "Initial", pay_method: "Bank", pay_date: TODAY, pay_amt: "3000", discount_type: "NONE" });
    expect(sent()).toEqual([expect.objectContaining({ idempotencyKey: `bookinn-receipt-${p.pay_id}` })]);
  });
});

describe("refund confirmations: one per refund", () => {
  it("confirms a Cancellation refund (and the returned points), and sends nothing for a late cancellation", async () => {
    const b = await book({ cus_id: "1002", discount_type: "12% Discount", stays: [stay("206", "2027-04-10", "2027-04-11")] });
    send.mockClear();
    const c = await cancelReservation(db, FRONT_DESK, b.resId, at("2027-04-01 09:00:00"));
    expect(sent()).toEqual([
      expect.objectContaining({ to: ["kdpalvarado@gmail.com"], subject: `BookInn refund confirmation for reservation #${b.resId}`, idempotencyKey: `bookinn-refund-${c.refundId}` }),
    ]);
    expect(sent()[0].text).toContain("Amount refunded: ₱1,320.00");
    expect(sent()[0].text).toContain("Loyalty points returned: 100");

    const late = await book({ cus_id: "1002", discount_type: "NONE", stays: [stay("206", "2027-05-10", "2027-05-11")] });
    send.mockClear();
    await cancelReservation(db, FRONT_DESK, late.resId, at("2027-05-09 09:00:00"));
    expect(send).not.toHaveBeenCalled();
  });

  it("confirms a Checkout Credit refund", async () => {
    const b = await book({ cus_id: "1001", discount_type: "NONE", stays: [stay("108", "2027-06-10", "2027-06-13")] });
    const r = await roomRow(b.resId);
    await modifyReservation(db, FRONT_DESK, b.resId, [{ res_room_id: r, room_no: "108", check_in_date: "2027-06-10", check_out_date: "2027-06-12" }], at("2027-06-01 09:00:00"));
    await checkInRoom(db, FRONT_DESK, r, at("2027-06-10 14:00:00"));
    await checkOutRoom(db, FRONT_DESK, r, at("2027-06-12 11:00:00"));
    send.mockClear();
    const s = await settleCheckout(db, FRONT_DESK, b.resId, {}, at("2027-06-12 11:05:00"));
    expect(sent()).toEqual([expect.objectContaining({ to: ["jdcruz@gmail.com"], idempotencyKey: `bookinn-refund-${s.refundId}` })]);
    expect(sent()[0].text).toContain("Refund: #");
    expect(sent()[0].text).toContain("Checkout Credit");
  });

  it("confirms the refund of a cancellation entered on the generic Cancellations form", async () => {
    send.mockClear();
    await createRow(db, FRONT_DESK, "cancellation", { res_id: "1004", cancel_date: TODAY }, TODAY);
    expect(sent()).toEqual([expect.objectContaining({ to: ["jdcruz@gmail.com"], subject: "BookInn refund confirmation for reservation #1004" })]);
  });
});

describe("No-Show notice after the daily job", () => {
  it("emails the guest after the job commits, stating No-Show, no refund, spent points not returned", async () => {
    send.mockClear();
    const r = await runMaintenance(db, { today: TODAY });
    expect(r.noShows).toEqual([1002]);
    expect(sent()).toEqual([
      expect.objectContaining({ to: ["kdpalvarado@gmail.com"], subject: "BookInn reservation #1002 marked No-Show", idempotencyKey: "bookinn-noshow-1002" }),
    ]);
    const text = sent()[0].text as string;
    expect(text).toContain("marked No-Show");
    expect(text).toContain("No refund is given");
    expect(text).toContain("Loyalty points spent: 100 (not returned)");
    expect(r.emails).toEqual([expect.objectContaining({ kind: "no-show", ref: 1002, status: "sent" })]);
  });
});

describe("email failures never break the flow", () => {
  it("keeps the booking when Resend returns an error, and reports the failure", async () => {
    send.mockResolvedValue({ data: null, error: { message: "domain not verified", name: "validation_error" }, headers: null });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const before = await count(db, "reservation");
    const b = await book({ cus_id: "1001", discount_type: "NONE", stays: [stay("205", "2027-07-01", "2027-07-02")] });
    expect(await count(db, "reservation")).toBe(before + 1);
    expect(b.emails).toEqual([expect.objectContaining({ status: "failed", reason: "domain not verified" })]);
    expect(errors).toHaveBeenCalled();
    expect(errors.mock.calls.flat().join(" ")).not.toContain(KEY); // the key is never logged
    errors.mockRestore();
  });

  it("keeps the cancellation and refund when Resend throws", async () => {
    const b = await book({ cus_id: "1001", discount_type: "NONE", stays: [stay("205", "2027-08-01", "2027-08-02")] });
    send.mockRejectedValue(new Error("network down"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const c = await cancelReservation(db, FRONT_DESK, b.resId, at("2027-07-01 09:00:00"));
    expect(c.emails).toEqual([expect.objectContaining({ kind: "refund", status: "failed", reason: "network down" })]);
    expect(await count(db, "refund", "res_id = $1", [b.resId])).toBe(1);
    errors.mockRestore();
  });

  it("keeps the daily job's changes when the No-Show email fails", async () => {
    // Demo reservation 1004 was cancelled above; make a new one that will be a No-Show.
    const b = await book({ cus_id: "1001", discount_type: "NONE", stays: [stay("406", "2027-09-01", "2027-09-02")] });
    send.mockRejectedValue(new Error("rate limited"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await runMaintenance(db, { today: "2027-09-03" });
    expect(r.noShows).toContain(b.resId);
    expect((await db.query("SELECT booking_status::text AS s FROM bookinn.reservation WHERE res_id = $1", [b.resId])).rows[0].s).toBe("No-Show");
    expect(r.emails.every((e) => e.status === "failed")).toBe(true);
    errors.mockRestore();
  });

  it("skips sending (and logs) when Resend is not configured", async () => {
    delete process.env.RESEND_API_KEY;
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const o = await sendReceipt(db, 1002); // (1001 was purged by the 2027-09-03 job run above)
    expect(o).toMatchObject({ status: "skipped", reason: expect.stringContaining("RESEND_API_KEY") });
    expect(send).not.toHaveBeenCalled();
    info.mockRestore();
    process.env.RESEND_API_KEY = KEY;
  });
});

describe("overdue list (FR-28)", () => {
  it("is computed on read for Finance and the Database Administrator only", async () => {
    // A guest still checked in after the latest check-out date.
    const b = await book({ cus_id: "1002", discount_type: "NONE", stays: [stay("207", "2027-10-01", "2027-10-02")] }, "2027-09-20").catch(async () => {
      await db.query("INSERT INTO bookinn.room (room_no, room_type_id) VALUES (207, 'RT01')");
      return book({ cus_id: "1002", discount_type: "NONE", stays: [stay("207", "2027-10-01", "2027-10-02")] }, "2027-09-20");
    });
    await checkInRoom(db, FRONT_DESK, await roomRow(b.resId), at("2027-10-01 14:00:00"));
    expect((await listOverdue(db, FINANCE, "2027-10-02")).map((r) => r.res_id)).not.toContain(b.resId);
    const rows = await listOverdue(db, ADMIN, "2027-10-04");
    expect(rows).toContainEqual(expect.objectContaining({ res_id: b.resId, booking_status: "Checked-In", rooms_checked_in: 1, days_overdue: 2, unpaid_charges: 0 }));
    await expect(listOverdue(db, FRONT_DESK)).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("daily job endpoint", () => {
  it("refuses requests without the cron secret and runs the job with it", async () => {
    const unauth = await cronGET(new Request("http://localhost/api/cron/maintenance"));
    expect(unauth.status).toBe(401);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const ok = await cronGET(new Request("http://localhost/api/cron/maintenance", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }));
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body).toMatchObject({ today: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), noShows: expect.any(Array), completed: expect.any(Number), purged: expect.any(Number) });
    expect(JSON.stringify(body)).not.toContain("@"); // no guest emails in the response
    info.mockRestore();
  });

  it("is scheduled at 00:05 Asia/Manila (16:05 UTC)", async () => {
    const { readFile } = await import("node:fs/promises");
    const cfg = JSON.parse(await readFile("vercel.json", "utf8"));
    expect(cfg.crons).toEqual([{ path: "/api/cron/maintenance", schedule: "5 16 * * *" }]);
  });
});

// Last on purpose: the No-Show test runs the daily job on a future date.
describe("email design: designed HTML plus a plain-text version", () => {
  const SELF_CONTAINED = /<script|<img|<link|<iframe|https?:\/\//i; // no images, scripts or external files

  it("receipt: brand header, details card, rooms, a highlighted total and the points note", async () => {
    const b = await book({ cus_id: "1002", discount_type: "NONE", stays: [stay("108", "2028-05-01", "2028-05-03")] }, "2028-04-01");
    const m = (await buildReceipt(db, b.payId))!;
    expect(m.html).toMatch(/^<!doctype html>/i);
    for (const part of ["BookInn", "Hotel reservations", "Paid", `Receipt #${b.rctNo}`, "Receipt number", "Room 108 · Deluxe, Pool View", "2 nights at ₱3,000.00 per night", "Amount paid", "₱6,000.00", "You will earn 60 loyalty points"])
      expect(m.html).toContain(part);
    expect(m.html).not.toMatch(SELF_CONTAINED);
    expect(m.html).toContain("display:none"); // preview line shown in inbox lists
    // The plain-text version carries the same facts.
    expect(m.text).toContain("Amount paid: ₱6,000.00");
    expect(m.text).toContain("Room 108 (Deluxe), 2028-05-01 to 2028-05-03");
    expect(m.text).not.toMatch(/<[a-z]/i);
  });

  it("receipt with a discount shows what was used; a Checkout receipt lists the charges with amounts", async () => {
    const d = await book({ cus_id: "1001", discount_type: "12% Discount", stays: [stay("205", "2028-05-10", "2028-05-12")] }, "2028-04-01");
    const dm = (await buildReceipt(db, d.payId))!;
    expect(dm.html).toContain("12% Discount applied: 100 loyalty points used.");
    expect(dm.html).not.toContain("You will earn"); // a discounted payment earns nothing

    const r = (await roomRow(d.resId)) ;
    await checkInRoom(db, FRONT_DESK, r, at("2028-05-10 14:00:00"));
    await extendStay(db, FRONT_DESK, r, "2028-05-13", {}, at("2028-05-11 10:00:00"));
    await checkOutRoom(db, FRONT_DESK, r, at("2028-05-13 11:00:00"));
    const s = await settleCheckout(db, FRONT_DESK, d.resId, { pay_method: "Cash", pay_amt: "1500" }, at("2028-05-13 11:05:00"));
    const cm = (await buildReceipt(db, s.payId!))!;
    expect(cm.html).toContain("Charges settled");
    expect(cm.html).toMatch(/Extension charge #\d+/);
    expect(cm.html).toContain("2028-05-12 to 2028-05-13");
    expect(cm.html).toContain("₱1,500.00");
    expect(cm.html).not.toContain(">Rooms<"); // rooms are listed on the booking receipt only
  });

  it("escapes guest-supplied text so it cannot inject HTML", async () => {
    const c = await createRow(db, FRONT_DESK, "customer", { cus_name: "Eve <script>alert(1)</script> & Co", cus_email: "eve.design@example.com", cus_mobile: "09170000009" });
    const b = await book({ cus_id: String(c.cus_id), discount_type: "NONE", stays: [stay("205", "2028-06-01", "2028-06-02")] }, "2028-04-01");
    const m = (await buildReceipt(db, b.payId))!;
    expect(m.html).not.toContain("<script");
    expect(m.html).toContain("Eve &lt;script&gt;alert(1)&lt;/script&gt; &amp; Co");
  });

  it("refund: a highlighted refunded amount, the returned points and the hand-over note", async () => {
    const b = await book({ cus_id: "1002", discount_type: "12% Discount", stays: [stay("206", "2028-06-10", "2028-06-11")] }, "2028-04-01");
    const c = await cancelReservation(db, FRONT_DESK, b.resId, at("2028-04-02 09:00:00"));
    const m = (await buildRefundConfirmation(db, c.refundId!))!;
    expect(m.html).toMatch(/^<!doctype html>/i);
    for (const part of ["Refund", "Refund confirmation", "Amount refunded", "₱1,320.00", "100 loyalty points you spent on this reservation have been returned", "The front desk hands over the refund."])
      expect(m.html).toContain(part);
    expect(m.html).not.toMatch(SELF_CONTAINED);
    expect(m.text).toContain("Amount refunded: ₱1,320.00");
  });

  it("No-Show: amber badge and a clear list of what it means", async () => {
    const b = await book({ cus_id: "1002", discount_type: "NONE", stays: [stay("406", "2028-07-01", "2028-07-02")] }, "2028-04-01");
    await runMaintenance(db, { today: "2028-07-03" });
    const m = (await buildNoShowNotice(db, b.resId))!;
    for (const part of ["No-Show", "Reservation marked No-Show", "What this means", "No refund is given.", "No loyalty points were spent on this reservation.", "No loyalty points are earned.", "Room 406 · Standard, Ocean View", "#8a5a00"])
      expect(m.html).toContain(part);
    expect(m.html).not.toMatch(SELF_CONTAINED);
    expect(m.text).toContain("No refund is given");
  });

  it("returns nothing for a missing record or a reservation that is not a No-Show", async () => {
    expect(await buildReceipt(db, 999_999)).toBeNull();
    expect(await buildRefundConfirmation(db, 999_999)).toBeNull();
    expect(await buildNoShowNotice(db, 1004)).toBeNull(); // 1004 is not a No-Show
  });
});
