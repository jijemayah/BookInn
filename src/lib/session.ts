/** Request-scoped session helpers (Next.js server only). */
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "./db/pg";
import { syncClock } from "./clock";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, loadActiveStaff, readSessionToken, signSession, type StaffSession } from "./staff-auth";

/**
 * Verifies the signed cookie AND re-checks the staff row (active + current role) once per request.
 * Every page and server action starts here, so this is also where the app's clock is checked
 * against the database (at most once a minute) before any date is computed.
 */
export const getCurrentStaff = cache(async (): Promise<StaffSession | null> => {
  const db = getDb();
  await syncClock(db);
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const staffId = await readSessionToken(token);
  return staffId === null ? null : loadActiveStaff(db, staffId);
});

export async function requireStaff(): Promise<StaffSession> {
  const s = await getCurrentStaff();
  if (!s) redirect("/login");
  return s;
}

export async function startSession(staffId: number) {
  (await cookies()).set(SESSION_COOKIE, await signSession(staffId), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function endSession() {
  (await cookies()).delete(SESSION_COOKIE);
}
