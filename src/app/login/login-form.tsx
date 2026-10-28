"use client";
import { useActionState } from "react";
import { loginAction } from "@/app/actions";

export function LoginForm() {
  const [state, action, pending] = useActionState(loginAction, {});
  return (
    <form action={action} className="form">
      {state.error && (
        <p className="alert error" role="alert">
          {state.error}
        </p>
      )}
      <div className="field">
        <label htmlFor="username">Username</label>
        <input id="username" name="username" required autoComplete="username" defaultValue={state.values?.username} />
      </div>
      <div className="field">
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" required autoComplete="current-password" />
      </div>
      <button type="submit" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
