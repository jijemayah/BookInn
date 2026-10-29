/** Framework-independent staff authentication (unit-testable). */
import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import type { Db } from "./db/types";
import type { Role } from "./entities";
import { AppError } from "./errors";
import { isStrongPassword, PASSWORD_RULE } from "./validation";
import { BCRYPT_COST } from "./rules";
import { setActor } from "./audit";

export interface StaffSession {
  staffId: number;
  role: Role;
  name: string;
  username: string;
}

// Compared against when the username doesn't exist, so response time doesn't reveal valid usernames.
let dummyHash: string | undefined;
const getDummyHash = () => (dummyHash ??= bcrypt.hashSync("not-a-real-password", BCRYPT_COST));

export async function verifyCredentials(db: Db, username: string, password: string): Promise<StaffSession | null> {
  const r = await db.query<{ staff_id: number; pass: string; name: string; role: Role; is_active: "Yes" | "No"; u_name: string }>(
    "SELECT staff_id, pass, name, role, is_active, u_name FROM bookinn.staff WHERE lower(u_name) = lower($1)",
    [username.trim()],
  );
  const s = r.rows[0];
  const ok = await bcrypt.compare(password, s?.pass ?? getDummyHash());
  if (!s || !ok || s.is_active !== "Yes") return null; // deactivated accounts cannot log in (SRS §3.3)
  return { staffId: s.staff_id, role: s.role, name: s.name, username: s.u_name };
}

/** Re-reads the staff row so deactivation / role changes take effect on the next request. */
export async function loadActiveStaff(db: Db, staffId: number): Promise<StaffSession | null> {
  const r = await db.query<{ staff_id: number; name: string; role: Role; u_name: string }>(
    "SELECT staff_id, name, role, u_name FROM bookinn.staff WHERE staff_id = $1 AND is_active = 'Yes'",
    [staffId],
  );
  const s = r.rows[0];
  return s ? { staffId: s.staff_id, role: s.role, name: s.name, username: s.u_name } : null;
}

/** FR-03: staff change their own password (current password required). */
export async function changeOwnPassword(db: Db, staffId: number, current: string, next: string) {
  if (!isStrongPassword(next)) throw new AppError("validation", PASSWORD_RULE, { new_password: PASSWORD_RULE });
  await db.tx(async (t) => {
    await setActor(t, { staffId });
    const r = await t.query<{ pass: string }>("SELECT pass FROM bookinn.staff WHERE staff_id = $1 FOR UPDATE", [staffId]);
    if (!r.rows[0] || !(await bcrypt.compare(current, r.rows[0].pass)))
      throw new AppError("validation", "Current password is incorrect.", { current_password: "Incorrect." });
    await t.query("UPDATE bookinn.staff SET pass = $2 WHERE staff_id = $1", [staffId, await bcrypt.hash(next, BCRYPT_COST)]);
  });
}

/** FR-03: staff update their own display name. Username, role and status are administrator-only. */
export async function updateOwnName(db: Db, staffId: number, name: string) {
  const n = name.trim();
  if (n.length < 1 || n.length > 100) throw new AppError("validation", "Enter your full name (max 100 characters).", { name: "Required." });
  await db.tx(async (t) => {
    await setActor(t, { staffId });
    await t.query("UPDATE bookinn.staff SET name = $2 WHERE staff_id = $1", [staffId, n]);
  });
}

// ---------------------------------------------------------------- signed session token
export const SESSION_COOKIE = "bookinn_session";
export const SESSION_TTL_SECONDS = 8 * 60 * 60; // one shift

function secretKey(secret: string | undefined = process.env.SESSION_SECRET) {
  if (!secret || secret.length < 32) throw new Error("SESSION_SECRET must be set to at least 32 random characters.");
  return new TextEncoder().encode(secret);
}

export async function signSession(staffId: number, secret?: string) {
  return new SignJWT({ sid: staffId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secretKey(secret));
}

export async function readSessionToken(token: string | undefined, secret?: string): Promise<number | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey(secret), { algorithms: ["HS256"] });
    return typeof payload.sid === "number" ? payload.sid : null;
  } catch {
    return null;
  }
}
