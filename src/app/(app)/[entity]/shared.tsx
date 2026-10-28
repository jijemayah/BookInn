import { notFound } from "next/navigation";
import type { Row } from "@/lib/db/types";
import { ENTITIES, canRead, isEntityKey, type EntityDef, type FieldDef } from "@/lib/entities";
import { requireStaff } from "@/lib/session";

/** Resolves the [entity] segment and enforces read permission. */
export async function loadEntityPage(entityParam: string) {
  if (!isEntityKey(entityParam)) notFound();
  const staff = await requireStaff();
  const e = ENTITIES[entityParam];
  const actor = { staffId: staff.staffId, role: staff.role };
  return { e, staff, actor, allowed: canRead(staff.role, e) };
}

export function Forbidden({ e }: { e: EntityDef }) {
  return (
    <>
      <h1>{e.plural}</h1>
      <p className="alert error" role="alert">
        Your role does not have access to {e.plural.toLowerCase()}.
      </p>
    </>
  );
}

export function cell(f: FieldDef, row: Row) {
  const v = row[f.name];
  if (v === null || v === undefined || v === "") return "—";
  if (f.type === "ref") return String(row[`${f.name}__label`] ?? v);
  if (f.type === "bool") return v ? "Yes" : "No";
  if (f.type === "money") return `₱${v}`;
  return String(v);
}

export const SAVED_MESSAGES: Record<string, string> = {
  created: "Record created.",
  updated: "Changes saved.",
  deleted: "Record deleted.",
};
