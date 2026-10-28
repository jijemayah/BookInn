import Link from "next/link";
import { getDb } from "@/lib/db/pg";
import { dependentsOf, getRow, listRows } from "@/lib/crud";
import { canRead, canWrite } from "@/lib/entities";
import { isAppError } from "@/lib/errors";
import { buildFormFields } from "@/lib/form-fields";
import { fromCents, reservationCost } from "@/lib/rules";
import { deleteAction, updateAction } from "@/app/actions";
import { DeleteButton, EntityForm } from "@/components/forms";
import { Forbidden, SAVED_MESSAGES, cell, loadEntityPage } from "../shared";
import { notFound } from "next/navigation";

export default async function DetailPage({ params, searchParams }: PageProps<"/[entity]/[id]">) {
  const { entity, id: rawId } = await params;
  const sp = await searchParams;
  const id = decodeURIComponent(rawId);
  const { e, actor, allowed } = await loadEntityPage(entity);
  if (!allowed) return <Forbidden e={e} />;
  const db = getDb();

  let row;
  try {
    row = await getRow(db, actor, e.key, id);
  } catch (err) {
    if (isAppError(err) && err.code === "not_found") notFound();
    throw err;
  }

  const writable = canWrite(actor.role, e);
  const fields = writable && !e.noUpdate ? await buildFormFields(db, actor, e, "update", row) : [];
  const related = await Promise.all(
    dependentsOf(e.key)
      .filter((d) => canRead(actor.role, d.entity))
      .map(async (d) => ({ ...d, rows: await listRows(db, actor, d.entity.key, { filter: { field: d.field, value: id }, limit: 50 }) })),
  );
  const cost = e.key === "reservation" ? await reservationCost(db, id) : null;
  const saved = typeof sp.saved === "string" ? SAVED_MESSAGES[sp.saved] : undefined;
  const title = `${e.label} ${id}`;

  return (
    <>
      <p>
        <Link href={`/${e.key}`}>← {e.plural}</Link>
      </p>
      <h1>{title}</h1>
      {saved && (
        <p className="alert ok" role="status">
          {saved}
        </p>
      )}

      <section className="card" aria-labelledby="details-h">
        <h2 id="details-h">Details</h2>
        <dl className="details">
          <dt>{e.pk.toUpperCase()}</dt>
          <dd>{String(row[e.pk])}</dd>
          {e.fields
            .filter((f) => f.type !== "password" && f.name !== e.pk)
            .map((f) => (
              <div key={f.name} style={{ display: "contents" }}>
                <dt>{f.label}</dt>
                <dd>{cell(f, row)}</dd>
              </div>
            ))}
          {cost && (
            <>
              <dt>Rooms booked</dt>
              <dd>{cost.rooms}</dd>
              <dt>Total cost (before discount)</dt>
              <dd>₱{fromCents(cost.totalCents)}</dd>
            </>
          )}
        </dl>
      </section>

      {related.map((d) => (
        <section className="card" key={`${d.entity.key}.${d.field}`} aria-label={d.entity.plural}>
          <h2>{d.entity.plural}</h2>
          {d.rows.length === 0 ? (
            <p className="muted">None.</p>
          ) : (
            <ul>
              {d.rows.map((r) => {
                const rid = String(r[d.entity.pk]);
                return (
                  <li key={rid}>
                    <Link href={`/${d.entity.key}/${encodeURIComponent(rid)}`}>
                      {d.entity.label} {rid}
                    </Link>{" "}
                    <span className="muted">
                      {d.entity.fields
                        .filter((f) => f.name !== d.field && f.type !== "password" && f.list !== false)
                        .slice(0, 4)
                        .map((f) => cell(f, r))
                        .join(" · ")}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {canWrite(actor.role, d.entity) && (
            <Link className="button secondary" href={`/${d.entity.key}/new`}>
              Add {d.entity.label.toLowerCase()}
            </Link>
          )}
        </section>
      ))}

      {fields.length > 0 && (
        <section className="card" aria-labelledby="edit-h">
          <h2 id="edit-h">Edit</h2>
          <EntityForm action={updateAction.bind(null, e.key, id)} fields={fields} submitLabel="Save changes" />
        </section>
      )}

      {writable && (
        <section className="card" aria-labelledby="delete-h">
          <h2 id="delete-h">Delete</h2>
          <p className="muted">
            Deletion is refused while other records depend on this one, so reservation, payment and audit history is never
            lost.
          </p>
          <DeleteButton action={deleteAction.bind(null, e.key, id)} label={title} />
        </section>
      )}
    </>
  );
}
