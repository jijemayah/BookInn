import { timingSafeEqual } from "node:crypto";

/** True when the request carries "Authorization: Bearer <CRON_SECRET>" (constant-time compare). */
export function isAuthorizedCron(header: string | null, secret = process.env.CRON_SECRET): boolean {
  if (!secret || secret.length < 16 || !header) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
