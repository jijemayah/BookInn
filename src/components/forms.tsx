"use client";
import { useActionState } from "react";
import type { FormState } from "@/app/actions";

export interface FormField {
  name: string;
  label: string;
  type: "text" | "email" | "int" | "money" | "date" | "enum" | "ref" | "password";
  required?: boolean;
  max?: number;
  min?: number;
  help?: string;
  placeholder?: string;
  options?: { value: string; label: string }[];
  /** Shown but not submitted (immutable on edit). */
  readOnly?: boolean;
  value?: string;
}

type Action = (prev: FormState, fd: FormData) => Promise<FormState>;

const PLACEHOLDERS: Partial<Record<FormField["type"], string>> = { money: "e.g. 1500.00", email: "name@example.com", int: "e.g. 205" };

export function EntityForm({ action, fields, submitLabel }: { action: Action; fields: FormField[]; submitLabel: string }) {
  const [state, formAction, pending] = useActionState(action, {});
  const val = (f: FormField) => state.values?.[f.name] ?? f.value ?? "";

  return (
    <form action={formAction} className="grid max-w-xl gap-4" noValidate>
      {state.error && (
        <p role="alert" className="rounded-md border border-[#f5c2bd] bg-danger-soft px-4 py-3 text-sm text-danger">
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
            <output id={id} className="block py-2 text-sm">
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
              placeholder={f.placeholder ?? PLACEHOLDERS[f.type]}
              autoComplete={f.type === "password" ? "new-password" : "off"}
            />
          );
        }
        return (
          <div className="grid gap-1" key={f.name}>
            <label htmlFor={id}>
              {f.label}
              {f.required && !f.readOnly && <span aria-hidden="true" className="text-danger"> *</span>}
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
      <div>
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </button>
      </div>
    </form>
  );
}

/** A button that asks for confirmation, then runs a server action (delete, cancel…). */
export function ConfirmButton({
  action,
  label,
  confirmText,
  pendingLabel = "Working…",
  variant = "danger",
}: {
  action: (prev: FormState) => Promise<FormState>;
  label: string;
  confirmText: string;
  pendingLabel?: string;
  variant?: "danger" | "secondary" | "primary";
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (!confirm(confirmText)) e.preventDefault();
      }}
    >
      {state.error && (
        <p role="alert" className="mb-3 rounded-md border border-[#f5c2bd] bg-danger-soft px-4 py-3 text-sm text-danger">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p role="status" className="mb-3 rounded-md border border-brand-300 bg-brand-100 px-4 py-3 text-sm text-brand-900">
          {state.ok}
        </p>
      )}
      <button type="submit" className={`btn btn-${variant}`} disabled={pending}>
        {pending ? pendingLabel : label}
      </button>
    </form>
  );
}

function SimpleField({ name, label, type = "text", autoComplete, state, defaultValue }: {
  name: string; label: string; type?: string; autoComplete?: string; state: FormState; defaultValue?: string;
}) {
  const err = state.fieldErrors?.[name];
  return (
    <div className="grid gap-1">
      <label htmlFor={name}>{label}</label>
      <input
        id={name} name={name} type={type} required autoComplete={autoComplete} defaultValue={defaultValue}
        aria-invalid={err ? true : undefined} aria-describedby={err ? `${name}_err` : undefined}
      />
      {err && <small id={`${name}_err`} className="field-error">{err}</small>}
    </div>
  );
}

function FormMessages({ state }: { state: FormState }) {
  return (
    <>
      {state.error && <p role="alert" className="rounded-md border border-[#f5c2bd] bg-danger-soft px-4 py-3 text-sm text-danger">{state.error}</p>}
      {state.ok && <p role="status" className="rounded-md border border-brand-300 bg-brand-100 px-4 py-3 text-sm text-brand-900">{state.ok}</p>}
    </>
  );
}

export function PasswordForm({ action }: { action: Action }) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="grid max-w-md gap-4">
      <FormMessages state={state} />
      <SimpleField name="current_password" label="Current password" type="password" autoComplete="current-password" state={state} />
      <SimpleField name="new_password" label="New password" type="password" autoComplete="new-password" state={state} />
      <SimpleField name="confirm_password" label="Confirm new password" type="password" autoComplete="new-password" state={state} />
      <div>
        <button type="submit" className="btn btn-primary" disabled={pending}>{pending ? "Saving…" : "Change password"}</button>
      </div>
    </form>
  );
}

export function NameForm({ action, name }: { action: Action; name: string }) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="grid max-w-md gap-4">
      <FormMessages state={state} />
      <SimpleField name="name" label="Full name" autoComplete="name" state={state} defaultValue={state.values?.name ?? name} />
      <div>
        <button type="submit" className="btn btn-primary" disabled={pending}>{pending ? "Saving…" : "Save name"}</button>
      </div>
    </form>
  );
}
