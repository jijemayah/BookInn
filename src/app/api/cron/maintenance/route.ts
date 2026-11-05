/**
 * Daily job endpoint for Vercel Cron (see vercel.json "crons").
 *
 * Schedule: Vercel Cron runs in UTC, so "5 16 * * *" (16:05 UTC) is 00:05
 * Asia/Manila (UTC+8, no daylight saving time), as SRS v2 §3.3 requires.
 *
 * Guard: Vercel sends "Authorization: Bearer <CRON_SECRET>" when CRON_SECRET
 * is set in the project's environment variables. Without a matching secret
 * the endpoint refuses to run. The job sets No-Show (and emails the guests
 * after commit), completes stranded reservations, and applies the one-year
 * retention purge. Email failures are logged and do not fail the run.
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
    const sent = result.emails.filter((e) => e.status === "sent").length;
    console.info(
      `[cron] daily job ${result.today}: noShows=${result.noShows.length} completed=${result.completed} purged=${result.purged} noShowEmailsSent=${sent}/${result.emails.length}`,
    );
    return Response.json({
      today: result.today,
      noShows: result.noShows,
      completed: result.completed,
      purged: result.purged,
      emails: result.emails.map((e) => ({ kind: e.kind, ref: e.ref, status: e.status })),
    });
  } catch (err) {
    console.error("[cron] daily job failed", err);
    return Response.json({ error: "Daily job failed" }, { status: 500 });
  }
}
