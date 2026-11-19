/**
 * Generic, RBAC-checked CRUD over the entity definitions. Every write runs in
 * one transaction together with its business-rule hooks; the audit triggers
 * record it under the acting staff member.
 */
import type { Db, Row } from "./db/types";
import { ENTITIES, ENTITY_KEYS, can, type EntityDef, type EntityKey, type Op } from "./entities";
import { AppError, isAppError } from "./errors";
import { setActor, setHotelDay, type Actor } from "./audit";
import { sendFor } from "./email";
import { parseInput, type FormInput } from "./validation";
import * as rules from "./rules";

const q = (ident: string) => `"${ident}"`; // identifiers come from ENTITIES only

export function assertCan(actor: Actor, e: EntityDef, op: Op) {
  if (!can(actor.role, e, op)) {
    console.warn(`[rbac] denied ${op} ${e.srsName} for staff ${actor.staffId} (${actor.role})`);
    const verb = op === "read" ? "view" : op === "create" ? "create" : op === "update" ? "edit" : "delete";
    throw new AppError("forbidden", `Your role (${actor.role}) cannot ${verb} ${e.plural.toLowerCase()}.`);
  }
}

/** Real table columns: password hashes are never selected; computed list columns are not columns. */
const tableFields = (e: EntityDef) => e.fields.filter((f) => !f.virtualSql);

/** Selectable columns — password hashes are never selected. */
function columns(e: EntityDef) {
  const cols = [e.pk, ...tableFields(e).filter((f) => f.type !== "password").map((f) => f.name)];
  return [...new Set(cols)];
}

function selectSql(e: EntityDef) {
  const cols = columns(e).map((c) => `m.${q(c)}`);
  // Cells show the short label (e.g. only the guest's name); dropdowns and search use the full one.
  const labels = e.fields
    .filter((f) => f.type === "ref")
    .map((f) => {
      const r = ENTITIES[f.ref!];
      return `(SELECT ${r.shortLabelSql ?? r.labelSql} FROM ${r.table} t WHERE t.${q(r.pk)} = m.${q(f.name)}) AS ${q(f.name + "__label")}`;
    });
  const virtual = e.fields.filter((f) => f.virtualSql).map((f) => `(${f.virtualSql}) AS ${q(f.name)}`);
  return `SELECT ${[...cols, ...labels, ...virtual].join(", ")} FROM ${e.table} m`;
}

// ---------------------------------------------------------------- reads
export interface ListOptions {
  q?: string;
  limit?: number;
  page?: number;
  sort?: string;
  dir?: "asc" | "desc";
  /** Exact-match filters; keys must be declared fields of the entity. */
  filters?: Record<string, string>;
}

export async function pageRows(db: Db, actor: Actor, key: EntityKey, opts: ListOptions = {}) {
  const e = ENTITIES[key];
  assertCan(actor, e, "read");
  const params: unknown[] = [];
  const where: string[] = [];
  for (const [field, value] of Object.entries(opts.filters ?? {})) {
    if (value === "") continue;
    // Only columns declared on the entity may be filtered on.
    if (field !== e.pk && !tableFields(e).some((f) => f.name === field)) throw new AppError("validation", "Unknown filter.");
    params.push(value);
    where.push(`m.${q(field)}::text = $${params.length}`);
  }
  const term = opts.q?.trim();
  if (term) {
    params.push(term);
    const n = params.length;
    const searchable = tableFields(e).filter((f) => ["text", "email", "enum", "date", "ref", "int", "money"].includes(f.type));
    const parts = [`m.${q(e.pk)}::text = $${n}`, ...searchable.map((f) => `m.${q(f.name)}::text ILIKE '%' || $${n} || '%'`)];
    // Search the human label of referenced rows too (e.g. a customer's name on a reservation).
    for (const f of e.fields.filter((x) => x.type === "ref")) {
      const r = ENTITIES[f.ref!];
      parts.push(`(SELECT ${r.labelSql} FROM ${r.table} t WHERE t.${q(r.pk)} = m.${q(f.name)}) ILIKE '%' || $${n} || '%'`);
    }
    where.push(`(${parts.join(" OR ")})`);
  }
  const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const total = Number(
    (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${e.table} m${whereSql}`, params)).rows[0].n,
  );

  const sortable = [e.pk, ...tableFields(e).filter((f) => f.type !== "password").map((f) => f.name)];
  const sort = opts.sort && sortable.includes(opts.sort) ? opts.sort : e.pk;
  const dir = opts.dir ?? (e.key === "audit_trail" ? "desc" : "asc");
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 500);
  const page = Math.max(opts.page ?? 1, 1);
  params.push(limit, (page - 1) * limit);
  const r = await db.query(
    `${selectSql(e)}${whereSql} ORDER BY m.${q(sort)} ${dir === "desc" ? "DESC" : "ASC"} NULLS LAST, m.${q(e.pk)} ${dir === "desc" ? "DESC" : "ASC"}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { rows: r.rows, total, page, limit, sort, dir };
}

export async function listRows(
  db: Db,
  actor: Actor,
  key: EntityKey,
  opts: { q?: string; limit?: number; filter?: { field: string; value: string } } = {},
) {
  const filters = opts.filter ? { [opts.filter.field]: opts.filter.value } : undefined;
  return (await pageRows(db, actor, key, { q: opts.q, limit: opts.limit ?? 200, filters })).rows;
}

export async function getRow(db: Db, actor: Actor, key: EntityKey, id: string | number) {
  const e = ENTITIES[key];
  assertCan(actor, e, "read");
  const r = await db.query(`${selectSql(e)} WHERE m.${q(e.pk)}::text = $1`, [String(id)]);
  if (!r.rows[0]) throw new AppError("not_found", `${e.label} ${id} was not found.`);
  return r.rows[0];
}

/** Options for a foreign-key <select>. */
export async function refOptions(db: Db, actor: Actor, key: EntityKey) {
  const e = ENTITIES[key];
  assertCan(actor, e, "read");
  const r = await db.query<{ value: string; label: string }>(
    `SELECT t.${q(e.pk)}::text AS value, ${e.labelSql} AS label FROM ${e.table} t ORDER BY t.${q(e.pk)} LIMIT 500`,
  );
  return r.rows;
}

/** Entities whose foreign keys point at `key` — used for delete guards and detail pages. */
export function dependentsOf(key: EntityKey) {
  return ENTITY_KEYS.flatMap((k) =>
    ENTITIES[k].fields
      .filter((f) => f.type === "ref" && f.ref === key && k !== "audit_trail")
      .map((f) => ({ entity: ENTITIES[k], field: f.name })),
  );
}

export async function countDependents(db: Db, key: EntityKey, id: unknown) {
  const out: { entity: EntityDef; count: number }[] = [];
  const deps = [...dependentsOf(key)];
  if (key === "staff") deps.push({ entity: ENTITIES.audit_trail, field: "staff_id" });
  for (const d of deps) {
    const r = await db.query(`SELECT count(*)::int AS n FROM ${d.entity.table} WHERE ${q(d.field)}::text = $1`, [String(id)]);
    const n = Number(r.rows[0].n);
    if (n > 0) out.push({ entity: d.entity, count: n });
  }
  return out;
}

async function lockRaw(db: Db, e: EntityDef, id: unknown) {
  const r = await db.query(`SELECT * FROM ${e.table} WHERE ${q(e.pk)}::text = $1 FOR UPDATE`, [String(id)]);
  if (!r.rows[0]) throw new AppError("not_found", `${e.label} ${id} was not found.`);
  return r.rows[0];
}

// ---------------------------------------------------------------- writes
export async function createRow(db: Db, actor: Actor, key: EntityKey, input: FormInput, today?: string): Promise<Row> {
  const e = ENTITIES[key];
  assertCan(actor, e, "create");
  if (key === "reservation")
    throw new AppError("validation", "Reservations are created with their rooms and payment on the New booking form.");
  const parsed = parseInput(e, "create", input, actor.role);
  const row = await run(e, () =>
    db.tx(async (t) => {
      await setActor(t, actor);
      if (today) await setHotelDay(t, today);
      const v = await rules.beforeCreate(t, e, parsed, actor, today);
      const cols = Object.keys(v);
      const r = await t.query(
        `INSERT INTO ${e.table} (${cols.map(q).join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`,
        cols.map((c) => v[c]),
      );
      const created = r.rows[0];
      await rules.afterCreate(t, e, created, today);
      return created;
    }),
  );
  // After commit: every payment gets a receipt email and every refund a confirmation (never fails the save).
  if (key === "payment") await sendFor(db, { payIds: [Number(row.pay_id)] });
  if (key === "refund") await sendFor(db, { refundIds: [Number(row.refund_id)] });
  if (key === "cancellation") {
    const refund = await db.query<{ refund_id: number }>(
      "SELECT refund_id FROM bookinn.refund WHERE res_id = $1 AND refund_type = 'Cancellation'",
      [row.res_id],
    );
    await sendFor(db, { refundIds: refund.rows.map((x) => x.refund_id) });
  }
  return row;
}

export async function updateRow(db: Db, actor: Actor, key: EntityKey, id: string | number, input: FormInput) {
  const e = ENTITIES[key];
  assertCan(actor, e, "update");
  const parsed = parseInput(e, "update", input, actor.role);
  return run(e, () =>
    db.tx(async (t) => {
      await setActor(t, actor);
      const old = await lockRaw(t, e, id);
      const v = await rules.beforeUpdate(t, e, old, parsed, actor);
      const changed = Object.keys(v).filter((c) => String(v[c]) !== String(old[c]));
      if (changed.length === 0) return old;
      const r = await t.query(
        `UPDATE ${e.table} SET ${changed.map((c, i) => `${q(c)} = $${i + 2}`).join(", ")} WHERE ${q(e.pk)}::text = $1 RETURNING *`,
        [String(id), ...changed.map((c) => v[c])],
      );
      return r.rows[0];
    }),
  );
}

export async function deleteRow(db: Db, actor: Actor, key: EntityKey, id: string | number) {
  const e = ENTITIES[key];
  assertCan(actor, e, "delete");
  return run(e, () =>
    db.tx(async (t) => {
      await setActor(t, actor);
      const old = await lockRaw(t, e, id);
      // Referential-integrity guard: refuse (never cascade) when other records depend on this row.
      const deps = await countDependents(t, key, id);
      if (deps.length)
        throw new AppError(
          "dependency",
          `Cannot delete ${e.label} ${id}: it is still referenced by ` +
            deps.map((d) => `${d.count} ${d.entity.plural.toLowerCase()}`).join(", ") +
            (key === "staff" ? ". Deactivate the account instead." : ". Remove those records first."),
        );
      await rules.beforeDelete(t, e, old, actor);
      await t.query(`DELETE FROM ${e.table} WHERE ${q(e.pk)}::text = $1`, [String(id)]);
      await rules.afterDelete(t, e, old);
      return old;
    }),
  );
}

// ---------------------------------------------------------------- DB error mapping
const CONSTRAINT_MESSAGES: Record<string, [string, string]> = {
  customer_email_uq: ["cus_email", "A customer with this email already exists."],
  loyalty_acc_cus_uq: ["cus_id", "This customer already has a loyalty account."],
  loyalty_acc_pts_chk: ["discount_type", "Not enough loyalty points."],
  payment_initial_uq: ["res_id", "This reservation already has its Initial payment."],
  payment_checkout_uq: ["res_id", "This reservation already has its Checkout payment."],
  payment_checkout_no_discount_chk: ["discount_type", "Checkout payments use no discount (NONE) and spend no points."],
  refund_cancellation_uq: ["res_id", "This reservation already has a Cancellation refund."],
  refund_checkout_credit_uq: ["res_id", "This reservation already has a Checkout Credit refund."],
  reservation_room_actual_in_chk: ["actual_check_in", "A room cannot be checked in before its check-in date."],
  reservation_room_actual_out_chk: ["actual_check_out", "Check-out must be after the room's check-in."],
  receipt_pay_uq: ["pay_id", "This payment already has a receipt."],
  cancellation_res_uq: ["res_id", "This reservation already has a cancellation record."],
  staff_u_name_uq: ["u_name", "That username is already taken."],
  staff_u_name_lower_uq: ["u_name", "That username is already taken."],
  reservation_room_dates_chk: ["check_out_date", "Check-out date must be after check-in date."],
};

const RULE_TRIGGERS = new Set([
  "room_price_fixed",
  "room_type_locked",
  "reservation_status_rule",
  "adjustment_charge_room_res",
  "adjustment_charge_extension_room",
  "adjustment_charge_extension_amt",
  "adjustment_charge_checkout_payment",
]);

export function mapDbError(err: unknown, e?: EntityDef): never {
  if (isAppError(err)) throw err;
  const pg = err as { code?: string; constraint?: string; detail?: string; message?: string };
  if (pg.code === "23P01" && pg.constraint === "room_double_booking")
    throw new AppError("conflict", pg.message ?? "Room is not available for these dates.", { room_no: "Not available for these dates." });
  // Business rules raised by database triggers carry a readable message (migration 0005).
  if (pg.code === "23514" && pg.constraint && RULE_TRIGGERS.has(pg.constraint))
    throw new AppError("conflict", pg.message ?? "This change breaks a business rule.");
  const known = pg.constraint ? CONSTRAINT_MESSAGES[pg.constraint] : undefined;
  if (known) throw new AppError(pg.code === "23505" ? "conflict" : "validation", known[1], { [known[0]]: known[1] });
  switch (pg.code) {
    case "23505":
      throw new AppError("conflict", e ? `A ${e.label.toLowerCase()} with this ${e.pk.toUpperCase()} already exists.` : "Duplicate record.", e ? {
        [e.pk]: "Already exists.",
      } : {});
    case "23503":
    case "23001": {
      const table = /table "(\w+)"/.exec(pg.detail ?? "")?.[1];
      throw new AppError(
        "dependency",
        pg.detail?.includes("still referenced")
          ? `This record is still referenced by ${table ?? "other"} records.`
          : "A referenced record does not exist.",
      );
    }
    case "22P02":
      if (/enum/i.test(pg.message ?? "")) throw new AppError("validation", "Choose one of the listed values.");
    // falls through
    case "23514":
    case "22001":
    case "22003":
      throw new AppError("validation", `Invalid value (${pg.constraint ?? pg.code}).`);
  }
  throw err;
}

async function run<T>(e: EntityDef, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    mapDbError(err, e);
  }
}
