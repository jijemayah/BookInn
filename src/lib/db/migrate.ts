import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Db } from "./types";

export const MIGRATIONS_DIR = path.resolve(process.cwd(), "db", "migrations");

/**
 * Applies db/migrations/*.sql in filename order, each in its own transaction,
 * recording applied files in bookinn.schema_migrations (bookkeeping table,
 * not an SRS entity). Safe to run repeatedly.
 */
export async function migrate(db: Db, dir = MIGRATIONS_DIR, log: (m: string) => void = () => {}) {
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS bookinn;
    CREATE TABLE IF NOT EXISTS bookinn.schema_migrations (
      filename   text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  const applied = new Set(
    (await db.query<{ filename: string }>("SELECT filename FROM bookinn.schema_migrations")).rows.map(
      (r) => r.filename,
    ),
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(dir, file), "utf8");
    await db.tx(async (t) => {
      await t.exec(sql);
      await t.query("INSERT INTO bookinn.schema_migrations (filename) VALUES ($1)", [file]);
    });
    ran.push(file);
    log(`applied ${file}`);
  }
  if (ran.length === 0) log("schema up to date");
  return ran;
}
