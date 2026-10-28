import { redirect } from "next/navigation";
import { getCurrentStaff } from "@/lib/session";
import { LoginForm } from "./login-form";

export default async function LoginPage() {
  if (await getCurrentStaff()) redirect("/");
  return (
    <main className="login">
      <div className="card">
        <h1>BookInn staff sign-in</h1>
        <LoginForm />
      </div>
    </main>
  );
}
