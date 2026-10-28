import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";

/** Load DB credentials for CLI scripts: .env.local first, then .env. */
export function loadEnv() {
  for (const f of [".env.local", ".env"]) if (existsSync(f)) process.loadEnvFile(f);
}

/** Random password that satisfies the SRS password policy. */
export function generatePassword() {
  const body = randomBytes(12).toString("base64url").replace(/[-_]/g, "x");
  return `Bk${body}#7`;
}
