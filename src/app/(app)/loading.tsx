export default function Loading() {
  return (
    <div role="status" aria-live="polite" className="animate-pulse">
      <div className="mb-4 h-7 w-56 rounded bg-brand-100" />
      <div className="mb-6 h-4 w-96 max-w-full rounded bg-brand-100" />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="h-24 rounded-xl bg-brand-100" />
        ))}
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
