/**
 * Guest emails through Resend (SRS v2 §1.4 Database and Deployment, §3.3
 * Receipt Generation, Refund Handling, No-Show Handling):
 *
 *   sendReceipt              every payment (Initial and Checkout), to the guest
 *   sendRefundConfirmation   every refund (Cancellation and Checkout Credit)
 *   sendNoShowNotice         right after the daily job sets a reservation to No-Show
 *
 * Rules:
 *   - Called only AFTER the transaction that recorded the payment, refund or
 *     No-Show has committed; never from inside a database transaction.
 *   - An email failure never throws: it is caught, logged and reported in the
 *     returned outcome, so bookings, payments, refunds and the daily job are
 *     never rolled back or interrupted by email.
 *   - Configuration comes from the environment: RESEND_API_KEY and
 *     RESEND_FROM_EMAIL. Without them, emails are skipped (logged), which is
 *     how development and tests run. The key is never logged.
 *   - Each email carries an idempotency key (receipt number, refund ID,
 *     reservation ID), so a retried request does not send it twice.
 */
import { Resend } from "resend";
import type { Db } from "./db/types";
import { peso, toCents } from "./money";

export type EmailKind = "receipt" | "refund" | "no-show";
export interface EmailOutcome {
  kind: EmailKind;
  ref: number;
  status: "sent" | "skipped" | "failed";
  to?: string;
  id?: string;
  reason?: string;
}

interface Mail {
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
}

const HOTEL = "BookInn";

let client: Resend | null = null;
let clientKey: string | undefined;

function resendClient(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  if (!client || clientKey !== key) {
    client = new Resend(key);
    clientKey = key;
  }
  return client;
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

/** Builds and sends one email; never throws. */
async function deliver(kind: EmailKind, ref: number, build: () => Promise<Mail | null>): Promise<EmailOutcome> {
  try {
    const mail = await build();
    if (!mail) return log({ kind, ref, status: "failed", reason: "record not found" });
    const from = process.env.RESEND_FROM_EMAIL;
    const resend = resendClient();
    if (!resend || !from) return log({ kind, ref, to: mail.to, status: "skipped", reason: "RESEND_API_KEY or RESEND_FROM_EMAIL is not set" });
    const { data, error } = await resend.emails.send(
      { from, to: [mail.to], subject: mail.subject, html: mail.html, text: mail.text },
      { idempotencyKey: mail.idempotencyKey },
    );
    if (error) return log({ kind, ref, to: mail.to, status: "failed", reason: errorText(error.message) });
    return log({ kind, ref, to: mail.to, status: "sent", id: data?.id });
  } catch (err) {
    return log({ kind, ref, status: "failed", reason: errorText(err) });
  }
}

function log(o: EmailOutcome): EmailOutcome {
  const line = `[email] ${o.kind} #${o.ref} ${o.status}${o.reason ? `: ${o.reason}` : ""}`;
  if (o.status === "failed") console.error(line);
  else console.info(line);
  return o;
}

/** Simple, readable layout shared by the three emails (inline styles for mail clients). */
function layout(title: string, intro: string, rows: [string, string][], extra = "") {
  const table = rows
    .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#555">${esc(k)}</td><td style="padding:4px 0"><strong>${esc(v)}</strong></td></tr>`)
    .join("");
  const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;max-width:560px;margin:0 auto;padding:16px">
<h2 style="color:#026E2F;margin:0 0 12px">${esc(HOTEL)}: ${esc(title)}</h2>
<p>${esc(intro)}</p>
<table style="border-collapse:collapse;margin:12px 0">${table}</table>
${extra}
<p style="color:#555;font-size:13px">${esc(HOTEL)} records payments and refunds; it does not process them. For questions, please contact the front desk.</p>
</body></html>`;
  const text = `${HOTEL}: ${title}\n\n${intro}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}\n\n${HOTEL} records payments and refunds; it does not process them. For questions, please contact the front desk.\n`;
  return { html, text };
}

const listHtml = (title: string, items: string[]) =>
  items.length ? `<p style="margin:12px 0 4px"><strong>${esc(title)}</strong></p><ul style="margin:0">${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : "";

async function roomsOf(db: Db, resId: unknown) {
  const r = await db.query<{ room_no: number; check_in_date: string; check_out_date: string; room_type: string }>(
    `SELECT rr.room_no, rr.check_in_date::text, rr.check_out_date::text, d.room_type::text
       FROM bookinn.reservation_room rr
       JOIN bookinn.room ro ON ro.room_no = rr.room_no
       JOIN bookinn.room_details d ON d.room_type_id = ro.room_type_id
      WHERE rr.res_id = $1 ORDER BY rr.check_in_date, rr.room_no`,
    [resId],
  );
  return r.rows.map((x) => `Room ${x.room_no} (${x.room_type}), ${x.check_in_date} to ${x.check_out_date}`);
}

// ---------------------------------------------------------------- receipt
export function sendReceipt(db: Db, payId: number): Promise<EmailOutcome> {
  return deliver("receipt", payId, async () => {
    const r = await db.query<{
      pay_id: number; res_id: number; pay_type: string; pay_method: string; pay_date: string; pay_amt: string;
      pts_earn: number; pts_spend: number; discount_type: string; rct_no: number | null; cus_name: string; cus_email: string;
    }>(
      `SELECT p.pay_id, p.res_id, p.pay_type::text, p.pay_method::text, p.pay_date::text, p.pay_amt::text,
              p.pts_earn, p.pts_spend, p.discount_type::text, rc.rct_no, c.cus_name, c.cus_email
         FROM bookinn.payment p
         JOIN bookinn.reservation r ON r.res_id = p.res_id
         JOIN bookinn.customer c ON c.cus_id = r.cus_id
         LEFT JOIN bookinn.receipt rc ON rc.pay_id = p.pay_id
        WHERE p.pay_id = $1`,
      [payId],
    );
    const p = r.rows[0];
    if (!p) return null;
    const charges = (
      await db.query<{ charge_id: number; charge_type: string; charge_amt: string; ext_from: string | null; ext_to: string | null }>(
        "SELECT charge_id, charge_type::text, charge_amt::text, ext_from::text, ext_to::text FROM bookinn.adjustment_charge WHERE pay_id = $1 ORDER BY charge_id",
        [payId],
      )
    ).rows.map((c) => `${c.charge_type} charge #${c.charge_id}${c.ext_from ? ` (${c.ext_from} to ${c.ext_to})` : ""}: ${peso(toCents(c.charge_amt))}`);
    const rows: [string, string][] = [
      ["Receipt number", p.rct_no ? String(p.rct_no) : "—"],
      ["Reservation", `#${p.res_id}`],
      ["Payment", `#${p.pay_id} (${p.pay_type})`],
      ["Date", p.pay_date],
      ["Method", p.pay_method],
      ["Amount paid", peso(toCents(p.pay_amt))],
    ];
    if (p.discount_type !== "NONE") rows.push(["Discount", `${p.discount_type} (${p.pts_spend} points used)`]);
    if (p.pts_earn > 0) rows.push(["Points earned", `${p.pts_earn} (added when your stay is completed)`]);
    const rooms = p.pay_type === "Initial" ? await roomsOf(db, p.res_id) : [];
    const { html, text } = layout(
      `Receipt #${p.rct_no ?? p.pay_id}`,
      `Dear ${p.cus_name}, thank you. This is your receipt for the ${p.pay_type === "Initial" ? "booking payment" : "check-out payment"} on reservation #${p.res_id}.`,
      rows,
      listHtml("Rooms", rooms) + listHtml("Charges settled", charges),
    );
    const extraText = [rooms.length ? `\nRooms:\n- ${rooms.join("\n- ")}` : "", charges.length ? `\nCharges settled:\n- ${charges.join("\n- ")}` : ""].join("");
    return {
      to: p.cus_email,
      subject: `${HOTEL} receipt #${p.rct_no ?? p.pay_id} for reservation #${p.res_id}`,
      html,
      text: text + extraText,
      idempotencyKey: `bookinn-receipt-${p.pay_id}`,
    };
  });
}

// ---------------------------------------------------------------- refund
export function sendRefundConfirmation(db: Db, refundId: number): Promise<EmailOutcome> {
  return deliver("refund", refundId, async () => {
    const r = await db.query<{
      refund_id: number; res_id: number; refund_type: string; refund_amt: string; refund_date: string; cus_name: string; cus_email: string; pts_spend: string;
    }>(
      `SELECT f.refund_id, f.res_id, f.refund_type::text, f.refund_amt::text, f.refund_date::text, c.cus_name, c.cus_email,
              (SELECT COALESCE(sum(pts_spend), 0)::text FROM bookinn.payment WHERE res_id = f.res_id) AS pts_spend
         FROM bookinn.refund f
         JOIN bookinn.reservation r ON r.res_id = f.res_id
         JOIN bookinn.customer c ON c.cus_id = r.cus_id
        WHERE f.refund_id = $1`,
      [refundId],
    );
    const f = r.rows[0];
    if (!f) return null;
    const cancellation = f.refund_type === "Cancellation";
    const rows: [string, string][] = [
      ["Refund", `#${f.refund_id} (${f.refund_type})`],
      ["Reservation", `#${f.res_id}`],
      ["Date", f.refund_date],
      ["Amount refunded", peso(toCents(f.refund_amt))],
    ];
    if (cancellation && Number(f.pts_spend) > 0) rows.push(["Loyalty points returned", f.pts_spend]);
    const { html, text } = layout(
      "Refund confirmation",
      cancellation
        ? `Dear ${f.cus_name}, your reservation #${f.res_id} was cancelled at least 48 hours before check-in, so the amount you paid is refunded in full.`
        : `Dear ${f.cus_name}, the changes to your reservation #${f.res_id} reduced your bill, so the difference is refunded to you at check-out.`,
      rows,
      "<p>The front desk hands over the refund.</p>",
    );
    return {
      to: f.cus_email,
      subject: `${HOTEL} refund confirmation for reservation #${f.res_id}`,
      html,
      text: `${text}The front desk hands over the refund.\n`,
      idempotencyKey: `bookinn-refund-${f.refund_id}`,
    };
  });
}

// ---------------------------------------------------------------- No-Show
export function sendNoShowNotice(db: Db, resId: number): Promise<EmailOutcome> {
  return deliver("no-show", resId, async () => {
    const r = await db.query<{ res_id: number; booking_status: string; cus_name: string; cus_email: string; pts_spend: string }>(
      `SELECT r.res_id, r.booking_status::text, c.cus_name, c.cus_email,
              (SELECT COALESCE(sum(pts_spend), 0)::text FROM bookinn.payment WHERE res_id = r.res_id) AS pts_spend
         FROM bookinn.reservation r JOIN bookinn.customer c ON c.cus_id = r.cus_id WHERE r.res_id = $1`,
      [resId],
    );
    const x = r.rows[0];
    if (!x || x.booking_status !== "No-Show") return null;
    const rooms = await roomsOf(db, resId);
    const rows: [string, string][] = [
      ["Reservation", `#${x.res_id}`],
      ["Status", "No-Show"],
      ["Refund", "None"],
      ["Loyalty points spent", Number(x.pts_spend) > 0 ? `${x.pts_spend} (not returned)` : "None"],
    ];
    const intro = `Dear ${x.cus_name}, your reservation #${x.res_id} has been marked No-Show because no room was checked in by the check-out date. No refund is given, and loyalty points spent on this reservation are not returned.`;
    const { html, text } = layout("Reservation marked No-Show", intro, rows, listHtml("Rooms", rooms));
    return {
      to: x.cus_email,
      subject: `${HOTEL} reservation #${x.res_id} marked No-Show`,
      html,
      text: text + (rooms.length ? `\nRooms:\n- ${rooms.join("\n- ")}\n` : ""),
      idempotencyKey: `bookinn-noshow-${x.res_id}`,
    };
  });
}

/** Sends the receipt and refund emails for whatever a committed flow produced. */
export async function sendFor(db: Db, ids: { payIds?: (number | null | undefined)[]; refundIds?: (number | null | undefined)[] }) {
  const out: EmailOutcome[] = [];
  for (const id of ids.payIds ?? []) if (id) out.push(await sendReceipt(db, id));
  for (const id of ids.refundIds ?? []) if (id) out.push(await sendRefundConfirmation(db, id));
  return out;
}
