/**
 * Daily maintenance endpoint for Vercel Cron (see vercel.json "crons").
 * Vercel sends "Authorization: Bearer <CRON_SECRET>" when CRON_SECRET is set
 * in the project's environment variables. Without a matching secret the
 * endpoint refuses to run.
 */
import { getDb } from "@/lib/db/pg";
import { runMaintenance } from "@/lib/maintenance";
import { isAuthorizedCron } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isAuthorizedCron(request.headers.get("authorization"))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await runMaintenance(getDb());
    console.info(`[cron] maintenance ${result.today}: completed=${result.completed} purged=${result.purged}`);
    return Response.json(result);
  } catch (err) {
    console.error("[cron] maintenance failed", err);
    return Response.json({ error: "Maintenance failed" }, { status: 500 });
  }
}
