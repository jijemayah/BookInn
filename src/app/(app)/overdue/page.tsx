import Link from "next/link";
import { getDb } from "@/lib/db/pg";
import { requireStaff } from "@/lib/session";
import { canViewOverdue, listOverdue } from "@/lib/overdue";
import { hotelToday } from "@/lib/dates";
import { peso, toCents } from "@/lib/money";
import { Alert, EmptyState, PageHeader, StatusBadge } from "@/components/ui";

/** FR-28: reservations past their latest check-out that are still Checked-In or have an Unpaid charge. */
export default async function OverduePage() {
  const staff = await requireStaff();
  const actor = { staffId: staff.staffId, role: staff.role };
  if (!canViewOverdue(actor))
    return (
      <>
        <PageHeader title="Overdue" />
        <Alert kind="error">The overdue list is available to Finance and the Database Administrator.</Alert>
      </>
    );
  const today = hotelToday();
  const rows = await listOverdue(getDb(), actor, today);
  const total = rows.reduce((a, r) => a + toCents(r.unpaid_amt), 0);

  return (
    <>
      <PageHeader
        title="Overdue reservations"
        description={`Computed now (${today}, Asia/Manila): latest check-out before today and still Checked-In or with an Unpaid charge. Nothing here is stored; the list is recalculated every time it is opened.`}
      />
      {rows.length === 0 ? (
        <EmptyState title="No overdue reservations." />
      ) : (
        <>
          <p className="mb-3 text-sm text-muted">
            {rows.length} reservation{rows.length === 1 ? "" : "s"} · Unpaid charges total {peso(total)}
          </p>
          <div className="overflow-x-auto rounded-xl border border-line bg-white">
            <table>
              <caption className="sr-only">Overdue reservations</caption>
              <thead>
                <tr>
                  <th scope="col">Reservation</th>
                  <th scope="col">Guest</th>
                  <th scope="col">Status</th>
                  <th scope="col">Latest check-out</th>
                  <th scope="col">Days overdue</th>
                  <th scope="col">Rooms still checked in</th>
                  <th scope="col">Unpaid charges</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.res_id}>
                    <td><Link href={`/reservation/${r.res_id}`}>#{r.res_id}</Link></td>
                    <td>
                      {r.cus_name}
                      <div className="text-xs text-muted">{r.cus_email} · {r.cus_mobile}</div>
                    </td>
                    <td><StatusBadge value={r.booking_status} /></td>
                    <td>{r.latest_check_out}</td>
                    <td>{r.days_overdue}</td>
                    <td>{r.rooms_checked_in}</td>
                    <td>{r.unpaid_charges === 0 ? "—" : `${peso(toCents(r.unpaid_amt))} (${r.unpaid_charges})`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-sm text-muted">
            Reservations with Unpaid charges are not deleted by the one-year retention purge until the balance is resolved.
          </p>
        </>
      )}
    </>
  );
}
