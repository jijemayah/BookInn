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
  if (f.name === "booking_status" || f.name === "is_active") return <StatusBadge value={String(v)} />;
  if (f.type === "money") return `₱${v}`;
  return String(v);
}

export const SAVED_MESSAGES: Record<string, string> = {
  created: "Record created.",
  updated: "Changes saved.",
  deleted: "Record deleted.",
  booked: "Booking confirmed.",
  cancelled: "Reservation cancelled.",
};
