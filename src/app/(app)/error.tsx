"use client"; // Error boundaries must be Client Components

import { useEffect } from "react";

export default function Error({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const digest = typeof error === "object" && error && "digest" in error ? String((error as { digest?: string }).digest) : undefined;
  return (
    <div role="alert" className="card max-w-xl">
      <h1 className="mb-2 text-xl">Something went wrong</h1>
      <p className="mb-4 text-sm text-muted">
        The page could not be loaded. If this keeps happening, tell the Database Administrator
        {digest ? ` and quote error code ${digest}` : ""}.
      </p>
      <button type="button" className="btn btn-primary" onClick={() => retry()}>
        Try again
      </button>
    </div>
  );
}
