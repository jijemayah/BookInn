import Link from "next/link";
import { getDb } from "@/lib/db/pg";
import { requireStaff } from "@/lib/session";
import { ENTITIES, ENTITY_KEYS, canRead } from "@/lib/entities";

export default async function Dashboard() {
  const staff = await requireStaff();
  const db = getDb();
  const keys = ENTITY_KEYS.filter((k) => canRead(staff.role, ENTITIES[k]));
  // Table names come from the static entity map, not user input.
  const counts = await Promise.all(
    keys.map(async (k) => Number((await db.query(`SELECT count(*)::int AS n FROM ${ENTITIES[k].table}`)).rows[0].n)),
  );
  return (
    <>
      <h1>Dashboard</h1>
      <p className="muted">Welcome, {staff.name}. Choose a record type to view or manage.</p>
      <div className="grid">
        {keys.map((k, i) => (
          <Link key={k} href={`/${k}`} className="card">
            <div className="count">{counts[i]}</div>
            <div>{ENTITIES[k].plural}</div>
          </Link>
        ))}
      </div>
    </>
  );
}
