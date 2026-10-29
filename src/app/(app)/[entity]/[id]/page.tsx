import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db/pg";
import { dependentsOf, getRow, listRows } from "@/lib/crud";
import { ENTITIES, can, canRead } from "@/lib/entities";
import { isAppError } from "@/lib/errors";
import { buildFormFields } from "@/lib/form-fields";
import { reservationCost } from "@/lib/rules";
import { peso } from "@/lib/money";
import type { Db, Row } from "@/lib/db/types";
import { cancelReservationAction, deleteAction, updateAction } from "@/app/actions";
import { ConfirmButton, EntityForm } from "@/components/forms";
import { PrintButton } from "@/components/print-button";
import { Alert, PageHeader, Section, StatusBadge } from "@/components/ui";
import { SAVED_MESSAGES, cell, loadEntityPage } from "../shared";

/** Receipt view: payment, reservation and guest details on one printable card. */
async function receiptDetails(db: Db, row: Row) {
  const r = await db.query(
    `SELECT p.pay_id, p.pay_method::text, p.pay_date, p.pay_amt::text, p.pts_earn, p.pts_spend, p.discount_type::text,
            res.res_id, res.booking_status::text, c.cus_name, c.cus_email, c.cus_mobile
       FROM bookinn.payment p
       JOIN bookinn.reservation res ON res.res_id = p.res_id
       JOIN bookinn.customer c ON c.cus_id = res.cus_id
      WHERE p.pay_id = $1`,
    [row.pay_id],
  );
  const rooms = await db.query(
    `SELECT rr.room_no, rr.check_in_date, rr.check_out_date, d.room_type::text, d.room_view::text
       FROM bookinn.reservation_room rr JOIN bookinn.room ro ON ro.room_no = rr.room_no
       JOIN bookinn.room_details d ON d.room_type_id = ro.room_type_id
      WHERE rr.res_id = (SELECT res_id FROM bookinn.payment WHERE pay_id = $1) ORDER BY rr.room_no`,
    [row.pay_id],
  );
  return { p: r.rows[0], rooms: rooms.rows };
}

export default async function DetailPage({ params, searchParams }: PageProps<"/[entity]/[id]">) {
  const { entity, id: rawId } = await params;
  const sp = await searchParams;
  const id = decodeURIComponent(rawId);
  const { e, actor, allowed } = await loadEntityPage(entity);
  if (!allowed)
    return (
      <>
        <PageHeader title={e.plural} />
        <Alert kind="error">Your role ({actor.role}) does not have access to {e.plural.toLowerCase()}.</Alert>
      </>
    );
  const db = getDb();

  let row: Row;
  try {
    row = await getRow(db, actor, e.key, id);
  } catch (err) {
    if (isAppError(err) && err.code === "not_found") notFound();
    throw err;
  }

  const canUpdate = can(actor.role, e, "update");
  const canDelete = can(actor.role, e, "delete");
  const fields = canUpdate ? await buildFormFields(db, actor, e, "update", row) : [];
  const related = await Promise.all(
    dependentsOf(e.key)
      .filter((d) => canRead(actor.role, d.entity))
      .map(async (d) => ({ ...d, rows: await listRows(db, actor, d.entity.key, { filter: { field: d.field, value: id }, limit: 50 }) })),
  );
  const cost = e.key === "reservation" ? await reservationCost(db, id) : null;
  const receipt = e.key === "receipt" ? await receiptDetails(db, row) : null;
  const saved = typeof sp.saved === "string" ? SAVED_MESSAGES[sp.saved] : undefined;
  const title = `${e.label} ${e.pkType === "int" ? "#" : ""}${id}`;
  const canCancel = e.key === "reservation" && row.booking_status === "Booked" && can(actor.role, ENTITIES.cancellation, "create");

  return (
    <>
      <PageHeader
        title={title}
        back={{ href: `/${e.key}`, label: e.plural }}
        actions={
          <>
            {e.key === "receipt" && <PrintButton label="Print receipt" />}
            {e.key === "customer" && can(actor.role, ENTITIES.reservation, "create") && (
              <Link href={`/book?cus_id=${encodeURIComponent(id)}`} className="btn btn-primary">Book for this guest</Link>
            )}
          </>
        }
      />
      {saved && <Alert kind="ok">{saved}</Alert>}

      {receipt?.p ? (
        <Section title={`Official record – Receipt #${id}`}>
          <dl className="details">
            <dt>Guest</dt><dd>{String(receipt.p.cus_name)} · {String(receipt.p.cus_email)} · {String(receipt.p.cus_mobile)}</dd>
            <dt>Reservation</dt><dd><Link href={`/reservation/${receipt.p.res_id}`}>#{String(receipt.p.res_id)}</Link> <StatusBadge value={String(receipt.p.booking_status)} /></dd>
            <dt>Rooms</dt>
            <dd>{receipt.rooms.map((r) => `Room ${r.room_no} (${r.room_type}, ${r.room_view}) ${r.check_in_date} → ${r.check_out_date}`).join("; ")}</dd>
            <dt>Payment</dt><dd><Link href={`/payment/${receipt.p.pay_id}`}>#{String(receipt.p.pay_id)}</Link> · {String(receipt.p.pay_method)} · {String(receipt.p.pay_date)}</dd>
            <dt>Discount</dt><dd>{String(receipt.p.discount_type)}</dd>
            <dt>Amount paid</dt><dd className="font-semibold">₱{String(receipt.p.pay_amt)}</dd>
            <dt>Loyalty points</dt><dd>+{String(receipt.p.pts_earn)} earned / −{String(receipt.p.pts_spend)} spent</dd>
          </dl>
          <p className="help mt-4">No refunds on cancellation (SRS §3.3). Email delivery of receipts is not configured; print or show this page to the guest.</p>
        </Section>
      ) : (
        <Section title="Details">
          <dl className="details">
            <dt>{e.pk.toUpperCase()}</dt>
            <dd>{String(row[e.pk])}</dd>
            {e.fields
              .filter((f) => f.type !== "password" && f.name !== e.pk)
              .map((f) => (
                <div key={f.name} className="contents">
                  <dt>{f.label}</dt>
                  <dd className="break-words">{cell(f, row)}</dd>
                </div>
              ))}
            {cost && (
              <>
                <dt>Rooms booked</dt>
                <dd>{cost.rooms}</dd>
                <dt>Base cost (before discount)</dt>
                <dd>{peso(cost.totalCents)} <span className="help">at current room prices</span></dd>
              </>
            )}
          </dl>
          {e.key === "reservation" && (
            <p className="help mt-4">
              Logged reservations cannot be edited (SRS §1.4). Front Desk may cancel a Booked reservation; the system marks it Completed the day after the latest check-out.
            </p>
          )}
        </Section>
      )}

      {canCancel && (
        <Section title="Cancel reservation">
          <p className="mb-4 text-sm text-muted">
            Cancelling frees the rooms for these dates. There is no cancellation fee and no refund; the payment record and any loyalty points earned or spent stay as they are.
          </p>
          <ConfirmButton
            action={cancelReservationAction.bind(null, id)}
            label={`Cancel reservation #${id}`}
            pendingLabel="Cancelling…"
            confirmText={`Cancel reservation #${id}? This cannot be undone by Front Desk and no refund is issued.`}
          />
        </Section>
      )}

      {related.map((d) => (
        <Section key={`${d.entity.key}.${d.field}`} title={d.entity.plural}>
          {d.rows.length === 0 ? (
            <p className="text-sm text-muted">None.</p>
          ) : (
            <ul className="divide-y divide-line text-sm">
              {d.rows.map((r) => {
                const rid = String(r[d.entity.pk]);
                return (
                  <li key={rid} className="py-2">
                    <Link href={`/${d.entity.key}/${encodeURIComponent(rid)}`}>
                      {d.entity.label} {d.entity.pkType === "int" ? "#" : ""}{rid}
                    </Link>{" "}
                    <span className="text-muted">
                      {d.entity.fields
                        .filter((f) => f.name !== d.field && f.type !== "password" && f.list !== false)
                        .slice(0, 5)
                        .map((f) => {
                          const c = cell(f, r);
                          return typeof c === "string" ? c : String(r[f.name]);
                        })
                        .join(" · ")}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      ))}

      {fields.length > 0 && (
        <Section title={e.correctionOnly ? "Correct this record (Database Administrator)" : "Edit"}>
          {e.correctionOnly && (
            <Alert kind="warn">
              Use this only to fix an entry error. Business rules still apply (availability, exact amount due, points) and the change is recorded in the audit trail.
            </Alert>
          )}
          <EntityForm action={updateAction.bind(null, e.key, id)} fields={fields} submitLabel="Save changes" />
        </Section>
      )}

      {canDelete && (
        <Section title="Delete">
          <p className="mb-4 text-sm text-muted">
            Deletion is refused while other records depend on this one, so reservation, payment and audit history is not lost.
            {e.key === "staff" && " Deactivate staff instead of deleting them."}
          </p>
          <ConfirmButton
            action={deleteAction.bind(null, e.key, id)}
            label={`Delete ${title}`}
            pendingLabel="Deleting…"
            confirmText={`Delete ${title}? This cannot be undone.`}
          />
        </Section>
      )}
    </>
  );
}
