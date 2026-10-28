import Link from "next/link";
import { getDb } from "@/lib/db/pg";
import { listRows } from "@/lib/crud";
import { canWrite } from "@/lib/entities";
import { Forbidden, SAVED_MESSAGES, cell, loadEntityPage } from "./shared";

export default async function ListPage({ params, searchParams }: PageProps<"/[entity]">) {
  const { entity } = await params;
  const sp = await searchParams;
  const { e, actor, allowed } = await loadEntityPage(entity);
  if (!allowed) return <Forbidden e={e} />;

  const q = typeof sp.q === "string" ? sp.q.slice(0, 100) : "";
  const rows = await listRows(getDb(), actor, e.key, { q });
  const cols = e.fields.filter((f) => f.list !== false && f.name !== e.pk);
  const saved = typeof sp.saved === "string" ? SAVED_MESSAGES[sp.saved] : undefined;

  return (
    <>
      <h1>{e.plural}</h1>
      <p className="muted">{e.description}</p>
      {saved && (
        <p className="alert ok" role="status">
          {saved}
        </p>
      )}
      <div className="toolbar">
        <form role="search">
          <label htmlFor="q" className="visually-hidden">
            Search {e.plural}
          </label>
          <input id="q" name="q" defaultValue={q} placeholder={`Search ${e.plural.toLowerCase()}…`} />
          <button type="submit">Search</button>
        </form>
        {canWrite(actor.role, e) && (
          <Link className="button" href={`/${e.key}/new`}>
            New {e.label.toLowerCase()}
          </Link>
        )}
      </div>
      {rows.length === 0 ? (
        <p>No records found.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <caption className="visually-hidden">{e.plural}</caption>
            <thead>
              <tr>
                <th scope="col">{e.pk.toUpperCase()}</th>
                {cols.map((f) => (
                  <th scope="col" key={f.name}>
                    {f.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const id = String(r[e.pk]);
                return (
                  <tr key={id}>
                    <td>
                      <Link href={`/${e.key}/${encodeURIComponent(id)}`}>{id}</Link>
                    </td>
                    {cols.map((f) => (
                      <td key={f.name}>{cell(f, r)}</td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
