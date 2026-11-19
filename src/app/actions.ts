"use server";
/**
 * Server Actions are public HTTP endpoints: every action re-authenticates the
 * caller, and the library layer re-checks RBAC, regardless of what the UI showed.
 */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db/pg";
import { createRow, deleteRow, updateRow } from "@/lib/crud";
import { cancelReservation, createBooking, quoteBooking, type BookingInput, type Quote } from "@/lib/booking";
import { roomAvailability } from "@/lib/dashboard";
import { isRealDate } from "@/lib/validation";
import { runMaintenance, type MaintenanceResult } from "@/lib/maintenance";
import { modifyReservation, type ModifyStayInput } from "@/lib/modify";
import { checkInRoom, checkOutRoom, extendStay, settleCheckout } from "@/lib/stay";
import { addRoomOption } from "@/lib/room-options";
import type { EmailOutcome } from "@/lib/email";
import { DBA, ENTITIES, isEntityKey } from "@/lib/entities";
import { AppError, isAppError } from "@/lib/errors";
import { changeOwnPassword, updateOwnName, verifyCredentials } from "@/lib/staff-auth";
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

export async function updateNameAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const a = await actor();
  const name = String(fd.get("name") ?? "");
  try {
    await updateOwnName(getDb(), a.staffId, name);
  } catch (err) {
    return fail(err, { name });
  }
  revalidatePath("/", "layout");
  return { ok: "Name updated.", values: { name: name.trim() } };
}

// ---------------------------------------------------------------- generic CRUD
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

// ---------------------------------------------------------------- bookings
export type BookingState = FormState & { quote?: Quote; rooms?: string[] };

function bookingInput(fd: FormData): { input: BookingInput; values: Record<string, string>; rooms: string[] } {
  const values = echo(formToInput(fd));
  const rooms = fd.getAll("room_no").map(String).filter(Boolean);
  return {
    input: {
      cus_id: values.cus_id ?? "",
      discount_type: values.discount_type || "NONE",
      // Each room carries its own check-in and check-out (in_<room> / out_<room>).
      stays: rooms.map((room_no) => ({
        room_no,
        check_in_date: values[`in_${room_no}`] ?? values.check_in_date ?? "",
        check_out_date: values[`out_${room_no}`] ?? values.check_out_date ?? "",
      })),
      pay_method: values.pay_method,
      pay_amt: values.pay_amt,
    },
    values,
    rooms,
  };
}

/** One form, two steps: "review" prices the booking; "confirm" saves it with the payment. */
/**
 * Booking form helper: which rooms are free for [from, to) (FR-13, FR-16). Read-only; the
 * booking itself re-checks availability on the server. Returns the taken room numbers.
 */
export async function roomAvailabilityAction(from: string, to: string): Promise<{ taken: number[]; error?: string }> {
  const a = await actor();
  if (!isRealDate(from) || !isRealDate(to) || to <= from) return { taken: [], error: "Choose a check-out date after the check-in date." };
  try {
    const rows = await roomAvailability(getDb(), a, from, to);
    return { taken: rows.filter((r) => !r.available).map((r) => r.room_no) };
  } catch (err) {
    return { taken: [], error: isAppError(err) ? err.message : "Could not check availability." };
  }
}

export async function bookingAction(_prev: BookingState, fd: FormData): Promise<BookingState> {
  const a = await actor();
  const { input, values, rooms } = bookingInput(fd);
  const intent = String(fd.get("$intent") ?? "review");
  if (intent === "edit") return { values, rooms };
  const db = getDb();
  if (intent === "review") {
    try {
      const quote = await quoteBooking(db, a, input);
      return { quote, values, rooms };
    } catch (err) {
      return { ...fail(err, values), rooms };
    }
  }
  let resId: number;
  let emails: EmailOutcome[] | undefined;
  try {
    ({ resId, emails } = await createBooking(db, a, input));
  } catch (err) {
    // Re-price so the summary stays visible next to the error when possible.
    const quote = await quoteBooking(db, a, input).catch(() => undefined);
    return { ...fail(err, values), quote, rooms };
  }
  revalidatePath("/reservation");
  redirect(resUrl(resId, "booked", emailParam(emails)));
}

/** Summarises the email outcomes of a flow for the page notice (?email=sent|skipped|failed). */
function emailParam(emails?: EmailOutcome[]) {
  if (!emails?.length) return "";
  const s = emails.some((e) => e.status === "failed") ? "failed" : emails.some((e) => e.status === "skipped") ? "skipped" : "sent";
  return `&email=${s}`;
}

const resUrl = (resId: string | number, saved: string, extra = "") => `/reservation/${encodeURIComponent(String(resId))}?saved=${saved}${extra}`;

export async function cancelReservationAction(resId: string, _prev: FormState): Promise<FormState> {
  const a = await actor();
  let url: string;
  try {
    const c = await cancelReservation(getDb(), a, resId);
    url = resUrl(resId, c.refundId ? "cancelled_refund" : "cancelled_norefund", emailParam(c.emails));
  } catch (err) {
    return fail(err, {});
  }
  revalidatePath("/reservation");
  redirect(url);
}

// ---------------------------------------------------------------- stay (Front Desk)
export async function checkInAction(resId: string, resRoomId: string, _prev: FormState): Promise<FormState> {
  const a = await actor();
  try {
    await checkInRoom(getDb(), a, resRoomId);
  } catch (err) {
    return fail(err, {});
  }
  revalidatePath("/reservation");
  redirect(resUrl(resId, "checked_in"));
}

export async function checkOutAction(resId: string, resRoomId: string, _prev: FormState): Promise<FormState> {
  const a = await actor();
  let url: string;
  try {
    const r = await checkOutRoom(getDb(), a, resRoomId);
    url = resUrl(resId, r.completed ? "checked_out_completed" : r.lastRoom && r.unpaidCount > 0 ? "checked_out_settle" : "checked_out");
  } catch (err) {
    return fail(err, {});
  }
  revalidatePath("/reservation");
  redirect(url);
}

export async function extendAction(resId: string, resRoomId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const a = await actor();
  const input = formToInput(fd);
  try {
    await extendStay(getDb(), a, resRoomId, String(input.new_check_out ?? ""), { roomNo: input.room_no || undefined });
  } catch (err) {
    return fail(err, input);
  }
  revalidatePath("/reservation");
  redirect(resUrl(resId, "extended"));
}

export async function modifyAction(resId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const a = await actor();
  const input = formToInput(fd);
  // Existing rows: room_<id>, in_<id>, out_<id>, remove_<id>. One optional new row: new_room, new_in, new_out.
  const ids = fd.getAll("row").map(String);
  const stays: ModifyStayInput[] = ids
    .filter((id) => input[`remove_${id}`] !== "on")
    .map((id) => ({ res_room_id: id, room_no: input[`room_${id}`] ?? "", check_in_date: input[`in_${id}`] ?? "", check_out_date: input[`out_${id}`] ?? "" }));
  if (input.new_room) stays.push({ room_no: input.new_room, check_in_date: input.new_in ?? "", check_out_date: input.new_out ?? "" });
  let url: string;
  try {
    const m = await modifyReservation(getDb(), a, resId, stays);
    url = resUrl(resId, m.differenceCents > 0 ? "modified_up" : m.differenceCents < 0 ? "modified_down" : "modified");
  } catch (err) {
    return fail(err, input);
  }
  revalidatePath("/reservation");
  redirect(url);
}

export async function settleAction(resId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const a = await actor();
  const input = formToInput(fd);
  let url: string;
  try {
    const s = await settleCheckout(getDb(), a, resId, { pay_method: input.pay_method, pay_amt: input.pay_amt });
    url = resUrl(resId, s.payId ? "settled_payment" : s.refundId ? "settled_credit" : "settled_zero", emailParam(s.emails));
  } catch (err) {
    return fail(err, input);
  }
  revalidatePath("/reservation");
  redirect(url);
}

// ---------------------------------------------------------------- room types and views (administrator)
export async function addRoomOptionAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const a = await actor();
  const input = formToInput(fd);
  try {
    const r = await addRoomOption(getDb(), a, input.kind === "room_view" ? "room_view" : "room_type", String(input.value ?? ""));
    revalidatePath("/room_details");
    return { ok: `Added ${r.kind === "room_view" ? "room view" : "room type"} "${r.value}". It can now be chosen when creating a room type.` };
  } catch (err) {
    return fail(err, input);
  }
}

// ---------------------------------------------------------------- maintenance
export async function runMaintenanceAction(_prev: FormState & { result?: MaintenanceResult }) {
  const a = await actor();
  try {
    if (a.role !== DBA) throw new AppError("forbidden", "Only the Database Administrator can run maintenance.");
    const result = await runMaintenance(getDb(), { staffId: a.staffId });
    revalidatePath("/", "layout");
    return {
      ok:
        `Daily job for ${result.today}: ${result.noShows.length} reservation(s) set to No-Show, ` +
        `${result.completed} marked Completed, ${result.purged} expired reservation(s) deleted. ` +
        `No-Show emails: ${result.emails.filter((e) => e.status === "sent").length} sent, ` +
        `${result.emails.filter((e) => e.status === "skipped").length} skipped, ${result.emails.filter((e) => e.status === "failed").length} failed.`,
      result,
    };
  } catch (err) {
    return fail(err, {});
  }
}
