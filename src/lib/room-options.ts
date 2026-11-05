/**
 * Room type names and room views (SRS v2 Table 26: "Allowed values: Standard,
 * Deluxe; the Database Administrator can add more room types and views").
 * They stay Postgres enums as the data dictionary says; the administrator
 * adds values here, and forms read the current list from the database.
 * Values can be added but not removed or renamed (rows may use them).
 */
import type { Db } from "./db/types";
import type { Actor } from "./audit";
import { DBA } from "./entities";
import { AppError } from "./errors";
import { ROOM_OPTION } from "./validation";

export type RoomOptionKind = "room_type" | "room_view";
const TYPES: Record<RoomOptionKind, "room_type_t" | "room_view_t"> = { room_type: "room_type_t", room_view: "room_view_t" };

/** Current values of an extendable enum, in their defined order. */
export async function enumValues(db: Db, type: "room_type_t" | "room_view_t"): Promise<string[]> {
  if (type !== "room_type_t" && type !== "room_view_t") throw new Error("Unknown enum");
  const r = await db.query<{ v: string }>(
    `SELECT e.enumlabel AS v FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'bookinn' AND t.typname = $1 ORDER BY e.enumsortorder`,
    [type],
  );
  return r.rows.map((x) => x.v);
}

export async function addRoomOption(db: Db, actor: Actor, kind: RoomOptionKind, raw: string) {
  if (actor.role !== DBA) throw new AppError("forbidden", "Only the Database Administrator can add room types and views.");
  const type = TYPES[kind];
  if (!type) throw new AppError("validation", "Choose room type or room view.");
  const value = raw.trim().replace(/\s+/g, " ");
  if (!ROOM_OPTION.test(value))
    throw new AppError("validation", "Use 2–30 letters and single spaces, e.g. Suite or Mountain View.", { value: "Letters and spaces only." });
  const existing = await enumValues(db, type);
  if (existing.some((v) => v.toLowerCase() === value.toLowerCase()))
    throw new AppError("conflict", `"${value}" already exists.`, { value: "Already exists." });
  // DDL cannot take parameters. `value` is restricted to letters and single spaces by
  // ROOM_OPTION above, and `type` comes from the fixed map, so this statement is safe.
  await db.query(`ALTER TYPE bookinn.${type} ADD VALUE '${value}'`);
  return { kind, value };
}
