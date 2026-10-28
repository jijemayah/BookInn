/**
 * Generic, RBAC-checked CRUD over the entity definitions. Every write runs in
 * one transaction together with its business-rule hooks and audit entry.
 */
import type { Db, Row } from "./db/types";
import { ENTITIES, ENTITY_KEYS, canRead, canWrite, type EntityDef, type EntityKey } from "./entities";
import { AppError, isAppError } from "./errors";
import { describe, writeAudit, type Actor } from "./audit";
import { parseInput, type FormInput } from "./validation";
import * as rules from "./rules";

const q = (ident: string) => `"${ident}"`; // identifiers come from ENTITIES only

function def(key: EntityKey) {
  return ENTITIES[key];
}

function assertRead(actor: Actor, e: EntityDef) {
  if (!canRead(actor.role, e)) {
    console.warn(`[rbac] denied read ${e.srsName} for staff ${actor.staffId} (${actor.role})`);
    throw new AppError("forbidden", `Your role (${actor.role}) cannot view ${e.plural}.`);
  }
}
function assertWrite(actor: Actor, e: EntityDef) {
  if (!canWrite(actor.role, e)) {
    console.warn(`[rbac] denied write ${e.srsName} for staff ${actor.staffId} (${actor.role})`);
    throw new AppError("forbidden", `Your role (${actor.role}) cannot modify ${e.plural}.`);
  }
}

/** Selectable columns — password hashes are never selected for display. */
function columns(e: EntityDef) {
  const cols = [e.pk, ...e.fields.filter((f) => f.type !== "password").map((f) => f.name)];
  return [...new Set(cols)];
}

function selectSql(e: EntityDef) {
  const cols = columns(e).map((c) => `m.${q(c)}`);
  const labels = e.fields
    .filter((f) => f.type === "ref")
    .map((f) => {
      const r = ENTITIES[f.ref!];
      return `(SELECT ${r.labelSql} FROM ${r.table} t WHERE t.${q(r.pk)} = m.${q(f.name)}) AS ${q(f.name + "__label")}`;
    });
  return `SELECT ${[...cols, ...labels].join(", ")} FROM ${e.table} m`;
}

// ---------------------------------------------------------------- reads
export async function listRows(
  db: Db,
  actor: Actor,
  key: EntityKey,
  opts: { q?: string; limit?: number; filter?: { field: string; value: string } } = {},
) {
  const e = def(key);
  assertRead(actor, e);
  const params: unknown[] = [];
  let where = "";
  const term = opts.q?.trim();
  if (opts.filter) {
    // Only columns declared on the entity may be filtered on.
    if (!e.fields.some((f) => f.name === opts.filter!.field)) throw new AppError("validation", "Unknown filter.");
    params.push(opts.filter.value);
    where = ` WHERE m.${q(opts.filter.field)}::text = $1`;
  } else if (term) {
    params.push(term);
    const searchable = e.fields.filter((f) => ["text", "email", "enum", "date"].includes(f.type));
    where =
      ` WHERE m.${q(e.pk)}::text = $1` +
      searchable.map((f) => ` OR m.${q(f.name)}::text ILIKE '%' || $1 || '%'`).join("");
  }
  params.push(Math.min(opts.limit ?? 200, 500));
  const dir = e.key === "audit_trail" ? "DESC" : "ASC";
  const r = await db.query(`${selectSql(e)}${where} ORDER BY m.${q(e.pk)} ${dir} LIMIT $${params.length}`, params);
  return r.rows;
}

export async function getRow(db: Db, actor: Actor, key: EntityKey, id: string | number) {
  const e = def(key);
  assertRead(actor, e);
  const r = await db.query(`${selectSql(e)} WHERE m.${q(e.pk)} = $1`, [String(id)]);
  if (!r.rows[0]) throw new AppError("not_found", `${e.label} ${id} was not found.`);
  return r.rows[0];
}

/** Options for a foreign-key <select>. */
export async function refOptions(db: Db, actor: Actor, key: EntityKey) {
  const e = def(key);
  assertRead(actor, e);
  const r = await db.query<{ value: string; label: string }>(
    `SELECT t.${q(e.pk)}::text AS value, ${e.labelSql} AS label FROM ${e.table} t ORDER BY t.${q(e.pk)} LIMIT 500`,
  );
  return r.rows;
}

/** Entities whose foreign keys point at `key` — used for delete guards and detail pages. */
export function dependentsOf(key: EntityKey) {
  return ENTITY_KEYS.flatMap((k) =>
    ENTITIES[k].fields.filter((f) => f.type === "ref" && f.ref === key).map((f) => ({ entity: ENTITIES[k], field: f.name })),
  );
}

export async function countDependents(db: Db, key: EntityKey, id: unknown) {
  const out: { entity: EntityDef; count: number }[] = [];
  for (const d of dependentsOf(key)) {
    const r = await db.query(`SELECT count(*)::int AS n FROM ${d.entity.table} WHERE ${q(d.field)} = $1`, [String(id)]);
    const n = Number(r.rows[0].n);
    if (n > 0) out.push({ entity: d.entity, count: n });
  }
  return out;
}

async function lockRaw(db: Db, e: EntityDef, id: unknown) {
  const r = await db.query(`SELECT * FROM ${e.table} WHERE ${q(e.pk)} = $1 FOR UPDATE`, [String(id)]);
  if (!r.rows[0]) throw new AppError("not_found", `${e.label} ${id} was not found.`);
  return r.rows[0];
}

// ---------------------------------------------------------------- writes
export async function createRow(db: Db, actor: Actor, key: EntityKey, input: FormInput): Promise<Row> {
  const e = def(key);
  assertWrite(actor, e);
  const parsed = parseInput(e, "create", input);
  return run(e, () =>
    db.tx(async (t) => {
      const v = await rules.beforeCreate(t, e, parsed, actor);
      const cols = Object.keys(v);
      const r = await t.query(
        `INSERT INTO ${e.table} (${cols.map(q).join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`,
        cols.map((c) => v[c]),
      );
      const row = r.rows[0];
      await writeAudit(t, actor, "INSERT", e, row, null, describe(e, row));
      await rules.afterCreate(t, e, row, actor);
      return row;
    }),
  );
}

export async function updateRow(db: Db, actor: Actor, key: EntityKey, id: string | number, input: FormInput) {
  const e = def(key);
  assertWrite(actor, e);
  if (e.noUpdate) throw new AppError("validation", `${e.plural} cannot be edited.`);
  const parsed = parseInput(e, "update", input);
  return run(e, () =>
    db.tx(async (t) => {
      const old = await lockRaw(t, e, id);
      const v = await rules.beforeUpdate(t, e, old, parsed, actor);
      const changed = Object.keys(v).filter((c) => String(v[c]) !== String(old[c]));
      if (changed.length === 0) return old;
      const r = await t.query(
        `UPDATE ${e.table} SET ${changed.map((c, i) => `${q(c)} = $${i + 2}`).join(", ")} WHERE ${q(e.pk)} = $1 RETURNING *`,
        [String(id), ...changed.map((c) => v[c])],
      );
      const row = r.rows[0];
      await writeAudit(t, actor, "UPDATE", e, row, describe(e, old, changed), describe(e, row, changed));
      return row;
    }),
  );
}

export async function deleteRow(db: Db, actor: Actor, key: EntityKey, id: string | number) {
  const e = def(key);
  assertWrite(actor, e);
  return run(e, () =>
    db.tx(async (t) => {
      const old = await lockRaw(t, e, id);
      // Referential-integrity guard: refuse (never cascade) when history depends on this row.
      const deps = await countDependents(t, key, id);
      if (deps.length)
        throw new AppError(
          "dependency",
          `Cannot delete ${e.label} ${id}: it is still referenced by ` +
            deps.map((d) => `${d.count} ${d.entity.plural.toLowerCase()}`).join(", ") +
            ". Remove those records first (or deactivate, for staff).",
        );
      await rules.beforeDelete(t, e, old, actor);
      await t.query(`DELETE FROM ${e.table} WHERE ${q(e.pk)} = $1`, [String(id)]);
      await writeAudit(t, actor, "DELETE", e, old, describe(e, old), null);
      await rules.afterDelete(t, e, old, actor);
      return old;
    }),
  );
}

// ---------------------------------------------------------------- DB error mapping
const CONSTRAINT_MESSAGES: Record<string, [string, string]> = {
  customer_email_uq: ["cus_email", "A customer with this email already exists."],
  loyalty_acc_cus_uq: ["cus_id", "This customer already has a loyalty account."],
  payment_res_uq: ["res_id", "This reservation already has a payment (one-time payment rule)."],
  receipt_pay_uq: ["pay_id", "This payment already has a receipt."],
  cancellation_res_uq: ["res_id", "This reservation already has a cancellation record."],
  staff_u_name_uq: ["u_name", "That username is already taken."],
  reservation_room_dates_chk: ["check_out_date", "Check-out date must be after check-in date."],
};

async function run<T>(e: EntityDef, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isAppError(err)) throw err;
    const pg = err as { code?: string; constraint?: string; detail?: string };
    const known = pg.constraint ? CONSTRAINT_MESSAGES[pg.constraint] : undefined;
    if (known) throw new AppError(pg.code === "23505" ? "conflict" : "validation", known[1], { [known[0]]: known[1] });
    switch (pg.code) {
      case "23505":
        throw new AppError("conflict", `A ${e.label.toLowerCase()} with this ${e.pk.toUpperCase()} already exists.`, {
          [e.pk]: "Already exists.",
        });
      case "23503":
      case "23001": {
        const table = /table "(\w+)"/.exec(pg.detail ?? "")?.[1];
        throw new AppError(
          "dependency",
          pg.detail?.includes("still referenced")
            ? `This ${e.label.toLowerCase()} is still referenced by ${table ?? "other"} records.`
            : "A referenced record does not exist.",
        );
      }
      case "23514":
      case "22P02":
      case "22001":
      case "22003":
        throw new AppError("validation", `Invalid value (${pg.constraint ?? pg.code}).`);
    }
    throw err;
  }
}
