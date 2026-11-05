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
 *
 * Every email is sent as a designed HTML message plus a plain-text version
 * with the same facts (for mail clients that do not show HTML). The layout is
 * email-safe: tables and inline styles only, no images or external files.
 */
import { Resend } from "resend";
import type { Db } from "./db/types";
import { peso, toCents } from "./money";
import { nightsBetween } from "./dates";

export type EmailKind = "receipt" | "refund" | "no-show";
export interface EmailOutcome {
  kind: EmailKind;
  ref: number;
  status: "sent" | "skipped" | "failed";
  to?: string;
  id?: string;
  reason?: string;
}

export interface Mail {
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

// ---------------------------------------------------------------- design
const C = {
  brand: "#026E2F",
  brandDark: "#004318",
  brandSoft: "#e8f5ec",
  brandLine: "#bfe0c9",
  warn: "#8a5a00",
  warnSoft: "#fff4dc",
  warnLine: "#f0d9a8",
  ink: "#1a1a1a",
  muted: "#5f6b66",
  line: "#e3e8e5",
  page: "#f3f5f4",
};
const FONT = "Arial,Helvetica,sans-serif";

type Tone = "ok" | "warn";
const tone = (t: Tone) => (t === "ok" ? { bg: C.brandSoft, fg: C.brandDark, line: C.brandLine } : { bg: C.warnSoft, fg: C.warn, line: C.warnLine });

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Small rounded label above the title, e.g. "PAID" or "NO-SHOW". */
const pill = (label: string, t: Tone) =>
  `<span style="display:inline-block;background:${tone(t).bg};color:${tone(t).fg};border:1px solid ${tone(t).line};border-radius:999px;padding:3px 12px;font-size:11px;font-weight:bold;letter-spacing:.8px;text-transform:uppercase">${esc(label)}</span>`;

/** Label / value rows inside a bordered box. */
function detailsBox(rows: [string, string][]) {
  const body = rows
    .map(
      ([k, v], i) =>
        `<tr><td style="padding:10px 14px;color:${C.muted};font-size:13px;${i ? `border-top:1px solid ${C.line};` : ""}">${esc(k)}</td>` +
        `<td align="right" style="padding:10px 14px;color:${C.ink};font-size:14px;font-weight:bold;${i ? `border-top:1px solid ${C.line};` : ""}">${esc(v)}</td></tr>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:8px;border-collapse:separate;margin:20px 0 0">${body}</table>`;
}

type Item = { title: string; sub?: string; amount?: string };

/** A headed list of rooms or charges; an amount column appears when items have amounts. */
function itemsBox(heading: string, items: Item[]) {
  if (!items.length) return "";
  const rows = items
    .map(
      (it, i) =>
        `<tr><td style="padding:12px 14px;${i ? `border-top:1px solid ${C.line};` : ""}"><div style="font-size:14px;font-weight:bold;color:${C.ink}">${esc(it.title)}</div>` +
        (it.sub ? `<div style="font-size:12px;color:${C.muted};margin-top:2px">${esc(it.sub)}</div>` : "") +
        `</td>` +
        (it.amount ? `<td align="right" valign="top" style="padding:12px 14px;font-size:14px;font-weight:bold;color:${C.ink};white-space:nowrap;${i ? `border-top:1px solid ${C.line};` : ""}">${esc(it.amount)}</td>` : "") +
        `</tr>`,
    )
    .join("");
  return (
    `<p style="margin:22px 0 6px;font-size:12px;font-weight:bold;letter-spacing:.8px;text-transform:uppercase;color:${C.muted}">${esc(heading)}</p>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:8px;border-collapse:separate">${rows}</table>`
  );
}

/** The highlighted bottom line: what was paid or refunded. */
const totalBar = (label: string, value: string, t: Tone = "ok") =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 0;background:${tone(t).bg};border:1px solid ${tone(t).line};border-radius:8px;border-collapse:separate">` +
  `<tr><td style="padding:16px 18px;font-size:14px;font-weight:bold;color:${tone(t).fg}">${esc(label)}</td>` +
  `<td align="right" style="padding:16px 18px;font-size:24px;font-weight:bold;color:${tone(t).fg}">${esc(value)}</td></tr></table>`;

/** A shaded note: one paragraph, or a short list. */
function callout(t: Tone, lines: string[], heading?: string) {
  const inner =
    lines.length === 1 && !heading
      ? `<p style="margin:0;font-size:14px;line-height:1.5;color:${tone(t).fg}">${esc(lines[0])}</p>`
      : (heading ? `<p style="margin:0 0 6px;font-size:14px;font-weight:bold;color:${tone(t).fg}">${esc(heading)}</p>` : "") +
        `<ul style="margin:0;padding-left:18px;font-size:14px;line-height:1.6;color:${tone(t).fg}">${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`;
  return `<div style="margin:20px 0 0;background:${tone(t).bg};border:1px solid ${tone(t).line};border-radius:8px;padding:14px 16px">${inner}</div>`;
}

/** The full HTML page: brand header, content card, footer. */
function frame(o: { preheader: string; badge: string; badgeTone: Tone; title: string; intro: string; content: string }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(o.title)}</title></head>
<body style="margin:0;padding:0;background:${C.page};font-family:${FONT};color:${C.ink}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px">${esc(o.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.page}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px">
<tr><td style="background:${C.brand};border-radius:12px 12px 0 0;padding:22px 28px">
<div style="font-size:24px;font-weight:bold;color:#ffffff;letter-spacing:.3px">${esc(HOTEL)}</div>
<div style="font-size:12px;color:#c9e8d3;margin-top:2px">Hotel reservations</div></td></tr>
<tr><td style="background:#ffffff;border:1px solid ${C.line};border-top:0;border-radius:0 0 12px 12px;padding:28px">
${pill(o.badge, o.badgeTone)}
<h1 style="margin:14px 0 8px;font-size:22px;line-height:1.3;color:${C.ink}">${esc(o.title)}</h1>
<p style="margin:0;font-size:15px;line-height:1.6;color:${C.ink}">${esc(o.intro)}</p>
${o.content}
</td></tr>
<tr><td style="padding:16px 12px 0;text-align:center;font-size:12px;line-height:1.6;color:${C.muted}">
${esc(HOTEL)} records payments and refunds; it does not process them.<br>For questions, please contact the front desk.</td></tr>
</table></td></tr></table></body></html>`;
}

/** Plain-text version with the same facts. */
function plain(title: string, intro: string, rows: [string, string][], extra = "") {
  return `${HOTEL}: ${title}\n\n${intro}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}\n${extra}\n${HOTEL} records payments and refunds; it does not process them. For questions, please contact the front desk.\n`;
}

type RoomLine = { room_no: number; room_type: string; room_view: string; room_price: string; check_in_date: string; check_out_date: string };

async function roomsOf(db: Db, resId: unknown): Promise<RoomLine[]> {
  const r = await db.query<RoomLine>(
    `SELECT rr.room_no, d.room_type::text, d.room_view::text, d.room_price::text, rr.check_in_date::text, rr.check_out_date::text
       FROM bookinn.reservation_room rr
       JOIN bookinn.room ro ON ro.room_no = rr.room_no
       JOIN bookinn.room_details d ON d.room_type_id = ro.room_type_id
      WHERE rr.res_id = $1 ORDER BY rr.check_in_date, rr.room_no`,
    [resId],
  );
  return r.rows;
}

const roomText = (x: RoomLine) => `Room ${x.room_no} (${x.room_type}), ${x.check_in_date} to ${x.check_out_date}`;
const roomItem = (x: RoomLine): Item => {
  const n = nightsBetween(x.check_in_date, x.check_out_date);
  return {
    title: `Room ${x.room_no} · ${x.room_type}, ${x.room_view}`,
    sub: `${x.check_in_date} to ${x.check_out_date} · ${n} night${n === 1 ? "" : "s"} at ${peso(toCents(x.room_price))} per night`,
  };
};
const textList = (heading: string, lines: string[]) => (lines.length ? `\n${heading}:\n- ${lines.join("\n- ")}\n` : "");

// ---------------------------------------------------------------- receipt
export async function buildReceipt(db: Db, payId: number): Promise<Mail | null> {
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
  ).rows;
  const rooms = p.pay_type === "Initial" ? await roomsOf(db, p.res_id) : [];
  const no = p.rct_no ?? p.pay_id;
  const initial = p.pay_type === "Initial";
  const title = `Receipt #${no}`;
  const intro = `Dear ${p.cus_name}, thank you. This is your receipt for the ${initial ? "booking payment" : "check-out payment"} on reservation #${p.res_id}.`;

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

  const chargeLines = charges.map(
    (c) => `${c.charge_type} charge #${c.charge_id}${c.ext_from ? ` (${c.ext_from} to ${c.ext_to})` : ""}: ${peso(toCents(c.charge_amt))}`,
  );
  // On screen the amount paid is the highlighted total, so the details box leaves it out.
  const detailRows = rows.filter(([k]) => !["Amount paid", "Discount", "Points earned"].includes(k));
  const content =
    detailsBox(detailRows) +
    itemsBox("Rooms", rooms.map(roomItem)) +
    itemsBox(
      "Charges settled",
      charges.map((c) => ({
        title: `${c.charge_type} charge #${c.charge_id}`,
        sub: c.ext_from ? `${c.ext_from} to ${c.ext_to}` : undefined,
        amount: peso(toCents(c.charge_amt)),
      })),
    ) +
    (p.discount_type !== "NONE" ? callout("ok", [`${p.discount_type} applied: ${p.pts_spend} loyalty points used.`]) : "") +
    totalBar("Amount paid", peso(toCents(p.pay_amt))) +
    (p.pts_earn > 0 ? callout("ok", [`You will earn ${p.pts_earn} loyalty points when your stay is completed.`]) : "");

  return {
    to: p.cus_email,
    subject: `${HOTEL} receipt #${no} for reservation #${p.res_id}`,
    html: frame({
      preheader: `Receipt #${no}: ${peso(toCents(p.pay_amt))} paid for reservation #${p.res_id}.`,
      badge: "Paid",
      badgeTone: "ok",
      title,
      intro,
      content,
    }),
    text: plain(title, intro, rows, textList("Rooms", rooms.map(roomText)) + textList("Charges settled", chargeLines)),
    idempotencyKey: `bookinn-receipt-${p.pay_id}`,
  };
}

export const sendReceipt = (db: Db, payId: number): Promise<EmailOutcome> => deliver("receipt", payId, () => buildReceipt(db, payId));

// ---------------------------------------------------------------- refund
export async function buildRefundConfirmation(db: Db, refundId: number): Promise<Mail | null> {
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
  const title = "Refund confirmation";
  const intro = cancellation
    ? `Dear ${f.cus_name}, your reservation #${f.res_id} was cancelled at least 48 hours before check-in, so the amount you paid is refunded in full.`
    : `Dear ${f.cus_name}, the changes to your reservation #${f.res_id} reduced your bill, so the difference is refunded to you at check-out.`;
  const rows: [string, string][] = [
    ["Refund", `#${f.refund_id} (${f.refund_type})`],
    ["Reservation", `#${f.res_id}`],
    ["Date", f.refund_date],
    ["Amount refunded", peso(toCents(f.refund_amt))],
  ];
  const points = cancellation && Number(f.pts_spend) > 0;
  if (points) rows.push(["Loyalty points returned", f.pts_spend]);

  const content =
    detailsBox(rows.filter(([k]) => k !== "Amount refunded" && k !== "Loyalty points returned")) +
    totalBar("Amount refunded", peso(toCents(f.refund_amt))) +
    (points ? callout("ok", [`${f.pts_spend} loyalty points you spent on this reservation have been returned to your account.`]) : "") +
    callout("ok", ["The front desk hands over the refund."]);

  return {
    to: f.cus_email,
    subject: `${HOTEL} refund confirmation for reservation #${f.res_id}`,
    html: frame({
      preheader: `${peso(toCents(f.refund_amt))} refunded for reservation #${f.res_id}.`,
      badge: "Refund",
      badgeTone: "ok",
      title,
      intro,
      content,
    }),
    text: plain(title, intro, rows, "\nThe front desk hands over the refund.\n"),
    idempotencyKey: `bookinn-refund-${f.refund_id}`,
  };
}

export const sendRefundConfirmation = (db: Db, refundId: number): Promise<EmailOutcome> =>
  deliver("refund", refundId, () => buildRefundConfirmation(db, refundId));

// ---------------------------------------------------------------- No-Show
export async function buildNoShowNotice(db: Db, resId: number): Promise<Mail | null> {
  const r = await db.query<{ res_id: number; booking_status: string; cus_name: string; cus_email: string; pts_spend: string }>(
    `SELECT r.res_id, r.booking_status::text, c.cus_name, c.cus_email,
            (SELECT COALESCE(sum(pts_spend), 0)::text FROM bookinn.payment WHERE res_id = r.res_id) AS pts_spend
       FROM bookinn.reservation r JOIN bookinn.customer c ON c.cus_id = r.cus_id WHERE r.res_id = $1`,
    [resId],
  );
  const x = r.rows[0];
  if (!x || x.booking_status !== "No-Show") return null;
  const rooms = await roomsOf(db, resId);
  const spent = Number(x.pts_spend);
  const title = "Reservation marked No-Show";
  const intro = `Dear ${x.cus_name}, your reservation #${x.res_id} has been marked No-Show because no room was checked in by the check-out date. No refund is given, and loyalty points spent on this reservation are not returned.`;
  const rows: [string, string][] = [
    ["Reservation", `#${x.res_id}`],
    ["Status", "No-Show"],
    ["Refund", "None"],
    ["Loyalty points spent", spent > 0 ? `${spent} (not returned)` : "None"],
  ];
  const content =
    detailsBox(rows) +
    itemsBox("Rooms", rooms.map(roomItem)) +
    callout(
      "warn",
      ["No refund is given.", spent > 0 ? `The ${spent} loyalty points you spent are not returned.` : "No loyalty points were spent on this reservation.", "No loyalty points are earned."],
      "What this means",
    );

  return {
    to: x.cus_email,
    subject: `${HOTEL} reservation #${x.res_id} marked No-Show`,
    html: frame({
      preheader: `Reservation #${x.res_id} was marked No-Show. No refund is given.`,
      badge: "No-Show",
      badgeTone: "warn",
      title,
      intro,
      content,
    }),
    text: plain(title, intro, rows, textList("Rooms", rooms.map(roomText))),
    idempotencyKey: `bookinn-noshow-${x.res_id}`,
  };
}

export const sendNoShowNotice = (db: Db, resId: number): Promise<EmailOutcome> => deliver("no-show", resId, () => buildNoShowNotice(db, resId));

/** Sends the receipt and refund emails for whatever a committed flow produced. */
export async function sendFor(db: Db, ids: { payIds?: (number | null | undefined)[]; refundIds?: (number | null | undefined)[] }) {
  const out: EmailOutcome[] = [];
  for (const id of ids.payIds ?? []) if (id) out.push(await sendReceipt(db, id));
  for (const id of ids.refundIds ?? []) if (id) out.push(await sendRefundConfirmation(db, id));
  return out;
}
