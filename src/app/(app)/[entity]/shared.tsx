import { notFound } from "next/navigation";
import type { Row } from "@/lib/db/types";
import { ENTITIES, canRead, isEntityKey, type FieldDef } from "@/lib/entities";
import { requireStaff } from "@/lib/session";
import { StatusBadge } from "@/components/ui";

/** Resolves the [entity] segment and enforces read permission. */
export async function loadEntityPage(entityParam: string) {
  if (!isEntityKey(entityParam)) notFound();
  const staff = await requireStaff();
  const e = ENTITIES[entityParam];
  const actor = { staffId: staff.staffId, role: staff.role };
  return { e, staff, actor, allowed: canRead(staff.role, e) };
}

export function cell(f: FieldDef, row: Row) {
  const v = row[f.name];
  if (v === null || v === undefined || v === "") return f.name === "staff_id" ? "System" : "—";
  if (f.type === "ref") return String(row[`${f.name}__label`] ?? v);
  if (f.name === "booking_status" || f.name === "is_active" || f.name === "pay_status") return <StatusBadge value={String(v)} />;
  if (f.type === "money") return `₱${v}`;
  return String(v);
}

export const SAVED_MESSAGES: Record<string, string> = {
  created: "Record created.",
  updated: "Changes saved.",
  deleted: "Record deleted.",
  booked: "Booking confirmed. The Initial payment and its receipt are recorded.",
  cancelled: "Reservation cancelled.",
  cancelled_refund: "Reservation cancelled at least 48 hours before check-in: a 100% refund is recorded. Hand the refund to the guest.",
  cancelled_norefund: "Reservation cancelled within 48 hours of check-in: no refund. Spent points were returned.",
  checked_in: "Room checked in.",
  checked_out: "Room checked out.",
  checked_out_settle: "Room checked out. No room is checked in now: settle the Unpaid charges below.",
  checked_out_completed: "Room checked out. Nothing is owed, so the reservation is Completed and earned points were credited.",
  extended: "Stay extended. The extra nights are posted as an Unpaid Extension charge, paid at check-out.",
  modified: "Reservation updated. No price change.",
  modified_up: "Reservation updated. The price increase is posted as an Unpaid Modification charge, paid at check-out.",
  modified_down: "Reservation updated. The price decrease is posted as a negative Modification charge.",
  settled_payment: "Checkout payment recorded and the charges are settled.",
  settled_credit: "The charges added up to less than zero: a Checkout Credit refund is recorded. Hand it to the guest.",
  settled_zero: "The charges cancelled each other out: nothing to pay or refund.",
};

export const EMAIL_MESSAGES: Record<string, { kind: "ok" | "warn"; text: string }> = {
  sent: { kind: "ok", text: "The email was sent to the guest." },
  skipped: { kind: "warn", text: "No email was sent: email (Resend) is not configured on this server." },
  failed: { kind: "warn", text: "The record was saved, but the email to the guest could not be sent. See the server log." },
};
