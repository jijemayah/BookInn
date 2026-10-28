"use client";
import { useActionState } from "react";
import type { FormState } from "@/app/actions";

export interface FormField {
  name: string;
  label: string;
  type: "text" | "email" | "int" | "money" | "date" | "enum" | "ref" | "password" | "bool";
  required?: boolean;
  max?: number;
  min?: number;
  help?: string;
  options?: { value: string; label: string }[];
  /** Shown but not submitted (immutable on edit). */
  readOnly?: boolean;
  value?: string;
}

type Action = (prev: FormState, fd: FormData) => Promise<FormState>;

export function EntityForm({ action, fields, submitLabel }: { action: Action; fields: FormField[]; submitLabel: string }) {
  const [state, formAction, pending] = useActionState(action, {});
  const val = (f: FormField) => state.values?.[f.name] ?? f.value ?? "";

  return (
    <form action={formAction} className="form" noValidate>
      {state.error && (
        <p className="alert error" role="alert">
          {state.error}
        </p>
      )}
      {fields.map((f) => {
        const id = `f_${f.name}`;
        const err = state.fieldErrors?.[f.name];
        const describedBy = [err && `${id}_err`, f.help && `${id}_help`].filter(Boolean).join(" ") || undefined;
        const common = {
          id,
          name: f.name,
          "aria-invalid": err ? true : undefined,
          "aria-describedby": describedBy,
          required: f.required && f.type !== "password" ? true : undefined,
        };
        // Re-key on each server response so defaultValue picks up echoed values.
        const key = `${f.name}:${val(f)}`;
        let control: React.ReactNode;
        if (f.readOnly) {
          control = (
            <output id={id} className="readonly">
              {f.options?.find((o) => o.value === f.value)?.label ?? f.value}
            </output>
          );
        } else if (f.type === "enum" || f.type === "ref") {
          control = (
            <select key={key} {...common} defaultValue={val(f)}>
              <option value="">— Select —</option>
              {f.options?.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          );
        } else if (f.type === "bool") {
          control = <input key={key} {...common} type="checkbox" defaultChecked={val(f) !== "false"} />;
        } else {
          const type =
            f.type === "email" ? "email" : f.type === "date" ? "date" : f.type === "password" ? "password" : f.type === "int" ? "number" : "text";
          control = (
            <input
              key={key}
              {...common}
              type={type}
              defaultValue={f.type === "password" ? undefined : val(f)}
              maxLength={f.max}
              min={f.type === "int" ? f.min : undefined}
              step={f.type === "int" ? 1 : undefined}
              inputMode={f.type === "money" ? "decimal" : undefined}
              autoComplete={f.type === "password" ? "new-password" : "off"}
            />
          );
        }
        return (
          <div className={`field ${f.type === "bool" ? "field-inline" : ""}`} key={f.name}>
            <label htmlFor={id}>
              {f.label}
              {f.required && !f.readOnly && <span aria-hidden="true"> *</span>}
            </label>
            {control}
            {f.help && (
              <small id={`${id}_help`} className="help">
                {f.help}
              </small>
            )}
            {err && (
              <small id={`${id}_err`} className="field-error">
                {err}
              </small>
            )}
          </div>
        );
      })}
      <button type="submit" disabled={pending}>
        {pending ? "Saving…" : submitLabel}
      </button>
    </form>
  );
}

export function DeleteButton({ action, label }: { action: (prev: FormState) => Promise<FormState>; label: string }) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (!confirm(`Delete ${label}? This cannot be undone.`)) e.preventDefault();
      }}
    >
      {state.error && (
        <p className="alert error" role="alert">
          {state.error}
        </p>
      )}
      <button type="submit" className="danger" disabled={pending}>
        {pending ? "Deleting…" : `Delete ${label}`}
      </button>
    </form>
  );
}

export function PasswordForm({ action }: { action: Action }) {
  const [state, formAction, pending] = useActionState(action, {});
  const field = (name: string, label: string, autoComplete: string) => (
    <div className="field">
      <label htmlFor={name}>{label}</label>
      <input id={name} name={name} type="password" required autoComplete={autoComplete} aria-invalid={state.fieldErrors?.[name] ? true : undefined} />
      {state.fieldErrors?.[name] && <small className="field-error">{state.fieldErrors[name]}</small>}
    </div>
  );
  return (
    <form action={formAction} className="form">
      {state.error && <p className="alert error" role="alert">{state.error}</p>}
      {state.ok && <p className="alert ok" role="status">{state.ok}</p>}
      {field("current_password", "Current password", "current-password")}
      {field("new_password", "New password", "new-password")}
      {field("confirm_password", "Confirm new password", "new-password")}
      <button type="submit" disabled={pending}>{pending ? "Saving…" : "Change password"}</button>
    </form>
  );
}
