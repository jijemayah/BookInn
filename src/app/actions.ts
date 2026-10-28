"use server";
/**
 * Server Actions are public HTTP endpoints: every action re-authenticates the
 * caller and the CRUD layer re-checks RBAC, regardless of what the UI showed.
 */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db/pg";
import { createRow, deleteRow, updateRow } from "@/lib/crud";
import { ENTITIES, isEntityKey } from "@/lib/entities";
import { isAppError } from "@/lib/errors";
import { changeOwnPassword, verifyCredentials } from "@/lib/staff-auth";
import { endSession, getCurrentStaff, startSession } from "@/lib/session";
import type { FormInput } from "@/lib/validation";

export type FormState = {
  error?: string;
  fieldErrors?: Record<string, string>;
  values?: Record<string, string>;
  ok?: string;
};

function formToInput(fd: FormData): FormInput {
  const out: FormInput = {};
  for (const [k, v] of fd.entries()) if (typeof v === "string" && !k.startsWith("$")) out[k] = v;
  return out;
}

/** Echo submitted values back to the form on error — never passwords. */
function echo(input: FormInput) {
  const v: Record<string, string> = {};
  for (const [k, val] of Object.entries(input)) if (!/pass/i.test(k) && val !== undefined) v[k] = val;
  return v;
}

async function actor() {
  const s = await getCurrentStaff();
  if (!s) redirect("/login");
  return { staffId: s.staffId, role: s.role };
}

function fail(err: unknown, input: FormInput): FormState {
  if (isAppError(err)) return { error: err.message, fieldErrors: err.fieldErrors, values: echo(input) };
  console.error(err);
  return { error: "Unexpected server error. Please try again.", values: echo(input) };
}

// ---------------------------------------------------------------- auth
export async function loginAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const username = String(fd.get("username") ?? "");
  const password = String(fd.get("password") ?? "");
  if (!username || !password) return { error: "Enter your username and password.", values: { username } };
  const staff = await verifyCredentials(getDb(), username, password);
  if (!staff) {
    console.warn(`[auth] failed login for "${username.slice(0, 30)}"`);
    return { error: "Invalid username or password, or the account is deactivated.", values: { username } };
  }
  await startSession(staff.staffId);
  redirect("/");
}

export async function logoutAction() {
  await endSession();
  redirect("/login");
}

export async function changePasswordAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const a = await actor();
  const next = String(fd.get("new_password") ?? "");
  if (next !== String(fd.get("confirm_password") ?? ""))
    return { fieldErrors: { confirm_password: "Passwords do not match." }, error: "Passwords do not match." };
  try {
    await changeOwnPassword(getDb(), a.staffId, String(fd.get("current_password") ?? ""), next);
  } catch (err) {
    return fail(err, {});
  }
  return { ok: "Password updated." };
}

// ---------------------------------------------------------------- CRUD
export async function createAction(entity: string, _prev: FormState, fd: FormData): Promise<FormState> {
  if (!isEntityKey(entity)) return { error: "Unknown entity." };
  const a = await actor();
  const input = formToInput(fd);
  let id: unknown;
  try {
    const row = await createRow(getDb(), a, entity, input);
    id = row[ENTITIES[entity].pk];
  } catch (err) {
    return fail(err, input);
  }
  revalidatePath(`/${entity}`);
  redirect(`/${entity}/${encodeURIComponent(String(id))}?saved=created`);
}

export async function updateAction(entity: string, id: string, _prev: FormState, fd: FormData): Promise<FormState> {
  if (!isEntityKey(entity)) return { error: "Unknown entity." };
  const a = await actor();
  const input = formToInput(fd);
  try {
    await updateRow(getDb(), a, entity, id, input);
  } catch (err) {
    return fail(err, input);
  }
  revalidatePath(`/${entity}`);
  redirect(`/${entity}/${encodeURIComponent(id)}?saved=updated`);
}

export async function deleteAction(entity: string, id: string, _prev: FormState): Promise<FormState> {
  if (!isEntityKey(entity)) return { error: "Unknown entity." };
  const a = await actor();
  try {
    await deleteRow(getDb(), a, entity, id);
  } catch (err) {
    return fail(err, {});
  }
  revalidatePath(`/${entity}`);
  redirect(`/${entity}?saved=deleted`);
}
