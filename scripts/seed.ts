import { generatePassword, loadEnv } from "./env";
import { closeDb, getDb } from "../src/lib/db/pg";
import { seed, SEED_USERNAMES } from "../src/lib/db/seed";
import { isStrongPassword, PASSWORD_RULE } from "../src/lib/validation";

loadEnv();

/** Passwords come from env, or are generated and printed ONCE. They are never stored in source. */
function pick(envName: string) {
  const v = process.env[envName];
  if (v && !isStrongPassword(v)) throw new Error(`${envName}: ${PASSWORD_RULE}`);
  return v ?? generatePassword();
}

async function main() {
  const pw = {
    admin: pick("SEED_ADMIN_PASSWORD"),
    frontDesk: pick("SEED_FRONTDESK_PASSWORD"),
    finance: pick("SEED_FINANCE_PASSWORD"),
  };
  const inserted = await seed(getDb(), pw);
  if (!inserted) {
    console.log("Staff table is not empty — seed skipped (existing data left untouched).");
    return;
  }
  console.log("Seeded SRS sample data. Initial logins (change them after first sign-in):");
  console.table([
    { username: SEED_USERNAMES.admin, role: "Database Administrator", password: pw.admin },
    { username: SEED_USERNAMES.frontDesk, role: "Front Desk", password: pw.frontDesk },
    { username: SEED_USERNAMES.finance, role: "Finance", password: pw.finance },
  ]);
}

main()
  .catch((e) => {
    console.error("Seed failed:", e.message);
    process.exitCode = 1;
  })
  .finally(closeDb);
