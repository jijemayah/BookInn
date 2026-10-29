"use client";
import { useActionState } from "react";
import { loginAction } from "@/app/actions";

export function LoginForm() {
  const [state, action, pending] = useActionState(loginAction, {});
  return (
    <form action={action} className="grid gap-4">
      {state.error && (
        <p role="alert" className="rounded-md border border-[#f5c2bd] bg-danger-soft px-4 py-3 text-sm text-danger">
          {state.error}
        </p>
      )}
      <div className="grid gap-1">
        <label htmlFor="username">Username</label>
        <input id="username" name="username" required autoComplete="username" defaultValue={state.values?.username} />
      </div>
      <div className="grid gap-1">
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" required autoComplete="current-password" />
      </div>
      <button type="submit" className="btn btn-primary w-full" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
