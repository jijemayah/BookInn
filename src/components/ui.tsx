/** Small presentational building blocks shared by the server-rendered pages. */
import Link from "next/link";
import type { ReactNode } from "react";

export function PageHeader({ title, description, actions, back }: { title: string; description?: ReactNode; actions?: ReactNode; back?: { href: string; label: string } }) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 max-w-3xl">
        {back && (
          <Link href={back.href} className="mb-2 inline-block text-sm">
            ← {back.label}
          </Link>
        )}
        <h1>{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  );
}

export function Alert({ kind, children }: { kind: "ok" | "error" | "info" | "warn"; children: ReactNode }) {
  const styles = {
    ok: "border-brand-300 bg-brand-100 text-brand-900",
    error: "border-[#f5c2bd] bg-danger-soft text-danger",
    warn: "border-[#f0d9a8] bg-warn-soft text-warn",
    info: "border-line bg-white text-ink",
  }[kind];
  return (
    <p role={kind === "error" ? "alert" : "status"} className={`mb-4 rounded-md border px-4 py-3 text-sm ${styles}`}>
      {children}
    </p>
  );
}

const STATUS_STYLES: Record<string, string> = {
  Booked: "bg-brand-200 text-brand-900",
  Completed: "bg-[#e5e7eb] text-[#374151]",
  Cancelled: "bg-danger-soft text-danger",
  Yes: "bg-brand-200 text-brand-900",
  No: "bg-[#e5e7eb] text-[#374151]",
};

export function StatusBadge({ value }: { value: string }) {
  return <span className={`badge ${STATUS_STYLES[value] ?? "bg-brand-100 text-brand-900"}`}>{value}</span>;
}

export function Stat({ label, value, hint, href }: { label: string; value: ReactNode; hint?: string; href?: string }) {
  const body = (
    <>
      <div className="text-sm text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-brand-900">{value}</div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </>
  );
  return href ? (
    <Link href={href} className="card block text-ink no-underline transition-colors hover:border-brand-400 hover:no-underline">
      {body}
    </Link>
  ) : (
    <div className="card">{body}</div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-brand-300 bg-white px-6 py-10 text-center">
      <p className="font-medium text-brand-900">{title}</p>
      {children && <div className="mt-2 text-sm text-muted">{children}</div>}
    </div>
  );
}

export function Section({ title, children, actions, id }: { title: string; children: ReactNode; actions?: ReactNode; id?: string }) {
  const hid = id ?? `s-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <section className="card mb-6" aria-labelledby={hid}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 id={hid}>{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}
