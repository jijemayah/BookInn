import { redirect } from "next/navigation";
import { getCurrentStaff } from "@/lib/session";
import { ClockWarningBanner } from "@/components/clock-warning";
import { LoginForm } from "./login-form";

export default async function LoginPage() {
  // getCurrentStaff also checks this computer's clock against the database.
  if (await getCurrentStaff()) redirect("/");
  return (
    <main className="flex min-h-screen items-center justify-center bg-brand-100 px-4">
      <div className="w-full max-w-sm">
        <p className="mb-6 text-center text-3xl font-bold tracking-tight text-brand-900">BookInn</p>
        <div className="mb-4">
          <ClockWarningBanner compact />
        </div>
        <div className="card">
          <h1 className="mb-1 text-xl">Staff sign-in</h1>
          <p className="mb-5 text-sm text-muted">Hotel reservation system. Staff accounts only.</p>
          <LoginForm />
        </div>
      </div>
    </main>
  );
}
