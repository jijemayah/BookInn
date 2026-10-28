import type { Db, Row } from "./db/types";
import type { EntityDef, Role } from "./entities";

export type Actor = { staffId: number; role: Role };
export type AuditAction = "INSERT" | "UPDATE" | "DELETE";

const MAX = 100; // AUDIT_TRAIL.OLD_DATA / NEW_DATA are varchar(100)

function fmt(v: unknown) {
  return v === null || v === undefined ? "NULL" : String(v);
}

/** "COL=value; COL=value" (SRS sample style), never containing password hashes. */
export function describe(e: EntityDef, row: Row, keys?: string[]): string {
  const cols = keys ?? e.fields.filter((f) => f.type !== "password").map((f) => f.name);
  const parts: string[] = [];
  // Non-integer PKs (ROOM_DETAILS) can't go in the int REC_ID column, so they lead the text.
  if (e.pkType !== "int" && !cols.includes(e.pk)) parts.push(`${e.pk.toUpperCase()}=${fmt(row[e.pk])}`);
  for (const c of cols) {
    if (c === "pass") parts.push("PASS=[changed]");
    else if (c in row) parts.push(`${c.toUpperCase()}=${fmt(row[c])}`);
  }
  const s = parts.join("; ");
  return s.length > MAX ? s.slice(0, MAX - 1) + "…" : s;
}

export async function writeAudit(
  db: Db,
  actor: Pick<Actor, "staffId">,
  action: AuditAction,
  e: EntityDef,
  row: Row,
  oldData: string | null,
  newData: string | null,
) {
  const recId = e.pkType === "int" ? Number(row[e.pk]) : null;
  await db.query(
    `INSERT INTO bookinn.audit_trail (staff_id, action, aff_tab, rec_id, old_data, new_data)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [actor.staffId, action, e.srsName, recId, oldData, newData],
  );
}
