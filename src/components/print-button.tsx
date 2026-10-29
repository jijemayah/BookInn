"use client";

export function PrintButton({ label = "Print" }: { label?: string }) {
  return (
    <button type="button" className="btn btn-secondary print:hidden" onClick={() => window.print()}>
      {label}
    </button>
  );
}
