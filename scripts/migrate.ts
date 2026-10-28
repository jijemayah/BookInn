import { loadEnv } from "./env";
import { closeDb, getDb } from "../src/lib/db/pg";
import { migrate } from "../src/lib/db/migrate";

loadEnv();
migrate(getDb(), undefined, console.log)
  .catch((e) => {
    console.error("Migration failed:", e.message);
    process.exitCode = 1;
  })
  .finally(closeDb);
