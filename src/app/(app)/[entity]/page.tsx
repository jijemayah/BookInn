import Link from "next/link";
import { getDb } from "@/lib/db/pg";
import { pageRows } from "@/lib/crud";
import { ENTITIES, can } from "@/lib/entities";
import { Alert, EmptyState, PageHeader } from "@/components/ui";
import { SAVED_MESSAGES, cell, loadEntityPage } from "./shared";

const PAGE_SIZE = 25;

export default async function ListPage({ params, searchParams }: PageProps<"/[entity]">) {
  const { entity } = await params;
  const sp = await searchParams;
  const { e, actor, allowed } = await loadEntityPage(entity);
  if (!allowed)
    return (
      <>
        <PageHeader title={e.plural} />
        <Alert kind="error">Your role ({actor.role}) does not have access to {e.plural.toLowerCase()}.</Alert>
      </>
    );

  const str = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const q = str("q").slice(0, 100);
  const filterFields = e.fields.filter((f) => f.filter && f.options);
  const filters = Object.fromEntries(
    filterFields.map((f) => [f.name, str(f.name)]).filter(([name, v]) => v && filterFields.find((f) => f.name === name)!.options!.includes(v)),
  );
  const page = Math.max(1, Number.parseInt(str("page"), 10) || 1);
  const sort = str("sort") || undefined;
  const dir = str("dir") === "desc" ? "desc" : str("dir") === "asc" ? "asc" : undefined;
  const res = await pageRows(getDb(), actor, e.key, { q, filters, page, limit: PAGE_SIZE, sort, dir });
  const cols = e.fields.filter((f) => f.list !== false && f.name !== e.pk);
  const saved = SAVED_MESSAGES[str("saved")];
  const pages = Math.max(1, Math.ceil(res.total / res.limit));

  const href = (over: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    const base: Record<string, string | number | undefined> = { q, ...filters, sort: res.sort, dir: res.dir, page: res.page, ...over };
    for (const [k, v] of Object.entries(base)) if (v !== undefined && v !== "" && !(k === "page" && v === 1)) p.set(k, String(v));
    const s = p.toString();
    return `/${e.key}${s ? `?${s}` : ""}`;
  };
  const sortLink = (col: string, label: string) => {
    const activeCol = res.sort === col;
    const nextDir = activeCol && res.dir === "asc" ? "desc" : "asc";
    return (
      <Link href={href({ sort: col, dir: nextDir, page: 1 })} className="text-brand-900 no-underline hover:underline">
        {label}
        {activeCol && <span aria-hidden="true">{res.dir === "asc" ? " ▲" : " ▼"}</span>}
        {activeCol && <span className="sr-only">{res.dir === "asc" ? " (sorted ascending)" : " (sorted descending)"}</span>}
      </Link>
    );
  };

  // Reservations are created on the booking form; other records (including administrator
  // corrections such as re-issuing a receipt) use the generic form.
  const newLink = !can(actor.role, e, "create") ? null : e.key === "reservation" ? (
    <Link className="btn btn-primary" href="/book">New booking</Link>
  ) : (
    <Link className="btn btn-primary" href={`/${e.key}/new`}>New {e.label.toLowerCase()}</Link>
  );

  return (
    <>
      <PageHeader title={e.plural} actions={newLink} />
      {saved && <Alert kind="ok">{saved}</Alert>}

      <form role="search" className="card mb-4 flex flex-wrap items-end gap-3 p-4" aria-label={`Search ${e.plural}`}>
        <div className="grid min-w-56 flex-1 gap-1">
          <label htmlFor="q">Search</label>
          <input id="q" name="q" defaultValue={q} placeholder={`ID, name, date… in ${e.plural.toLowerCase()}`} />
        </div>
        {filterFields.map((f) => (
          <div key={f.name} className="grid gap-1">
            <label htmlFor={`flt_${f.name}`}>{f.label}</label>
            <select id={`flt_${f.name}`} name={f.name} defaultValue={filters[f.name] ?? ""} className="w-auto">
              <option value="">All</option>
              {f.options!.map((o) => <option key={o}>{o}</option>)}
            </select>
          </div>
        ))}
        {res.sort !== e.pk && <input type="hidden" name="sort" value={res.sort} />}
        <button type="submit" className="btn btn-secondary">Apply</button>
        {(q || Object.keys(filters).length > 0) && <Link href={`/${e.key}`} className="btn btn-ghost">Clear</Link>}
      </form>

      {res.rows.length === 0 ? (
        <EmptyState title={q || Object.keys(filters).length ? "No records match your search." : `No ${e.plural.toLowerCase()} yet.`} />
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border border-line bg-white">
            <table>
              <caption className="sr-only">{e.plural}, page {res.page} of {pages}</caption>
              <thead>
                <tr>
                  <th scope="col">{sortLink(e.pk, e.pk.toUpperCase())}</th>
                  {cols.map((f) => (
                    <th scope="col" key={f.name}>{f.type === "ref" ? f.label : sortLink(f.name, f.label)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {res.rows.map((r) => {
                  const id = String(r[e.pk]);
                  return (
                    <tr key={id}>
                      <td><Link href={`/${e.key}/${encodeURIComponent(id)}`}>{id}</Link></td>
                      {cols.map((f) => (
                        <td key={f.name} className={f.name === "old_data" || f.name === "new_data" ? "max-w-xs break-words" : undefined}>{cell(f, r)}</td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <nav aria-label="Pagination" className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
            <span className="text-muted">
              {(res.page - 1) * res.limit + 1}–{Math.min(res.page * res.limit, res.total)} of {res.total}
            </span>
            <span className="flex gap-2">
              {res.page > 1 ? <Link href={href({ page: res.page - 1 })} className="btn btn-secondary">Previous</Link> : <span className="btn btn-secondary opacity-50" aria-disabled="true">Previous</span>}
              <span className="self-center">Page {res.page} of {pages}</span>
              {res.page < pages ? <Link href={href({ page: res.page + 1 })} className="btn btn-secondary">Next</Link> : <span className="btn btn-secondary opacity-50" aria-disabled="true">Next</span>}
            </span>
          </nav>
        </>
      )}
      {e.key === "room" && <p className="mt-4 text-sm text-muted">Check availability for specific dates on the <Link href="/">dashboard</Link>.</p>}
      {e.key === "payment" && (
        <p className="mt-4 text-sm text-muted">Payments are recorded with each booking on the <Link href={can(actor.role, ENTITIES.reservation, "create") ? "/book" : "/reservation"}>booking form</Link>.</p>
      )}
    </>
  );
}
