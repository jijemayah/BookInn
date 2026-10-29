import Link from "next/link";

export default function NotFound() {
  return (
    <div className="card max-w-xl">
      <h1 className="mb-2 text-xl">Not found</h1>
      <p className="mb-4 text-sm text-muted">That record or page does not exist. It may have been deleted, for example by the one-year retention rule.</p>
      <Link href="/" className="btn btn-primary">Back to dashboard</Link>
    </div>
  );
}
