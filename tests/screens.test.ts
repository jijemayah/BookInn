/**
 * Stage 4 library pieces behind the screens: which actions the reservation
 * page offers per role and status (SRS v2 Table 2 and Table 3), room types and
 * views the administrator can add (Table 26), the fixed ROOM_PRICE on the
 * edit form, and the dashboard counts for the new statuses.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/types";
import { createBooking, quoteBooking } from "@/lib/booking";
import { createRow, getRow, pageRows, refOptions, updateRow } from "@/lib/crud";
import { checkInRoom, checkOutRoom } from "@/lib/stay";
import { reservationView } from "@/lib/reservation-view";
import { addRoomOption, enumValues } from "@/lib/room-options";
import { buildFormFields } from "@/lib/form-fields";
import { dashboardStats, dashboardTrends, roomAvailability } from "@/lib/dashboard";
import { ENTITIES } from "@/lib/entities";
import { atHotelTime } from "@/lib/dates";
import { ADMIN, FINANCE, FRONT_DESK, freshDb } from "./helpers";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await freshDb()));
afterAll(() => close());

const at = (s: string) => atHotelTime(s);

describe("reservation page actions follow the role permissions and statuses", () => {
  it("offers edit and cancel on a Booked reservation before the cutoff, to Front Desk and the administrator only", async () => {
    const fd = await reservationView(db, FRONT_DESK, 1004, at("2026-11-01 10:00:00"));
    expect(fd).toMatchObject({ status: "Booked", canAct: true, canModify: true, canCancel: true, canSettle: false, beforeCutoff: true, cutoff: "2026-12-18 14:00:00", paidCents: 300_000 });
    expect(fd!.rooms[0]).toMatchObject({ room_no: 206, canCheckIn: false, canCheckOut: false, canExtend: false });
    expect(await reservationView(db, ADMIN, 1004, at("2026-11-01 10:00:00"))).toMatchObject({ canModify: true, canCancel: true });
    expect(await reservationView(db, FINANCE, 1004, at("2026-11-01 10:00:00"))).toMatchObject({ canAct: false, canModify: false, canCancel: false });
    // After the cutoff: no edits, cancellation still possible (without refund).
    expect(await reservationView(db, FRONT_DESK, 1004, at("2026-12-18 14:00:01"))).toMatchObject({ beforeCutoff: false, canModify: false, canCancel: true });
    // On the check-in date the room can be checked in.
    expect((await reservationView(db, FRONT_DESK, 1004, at("2026-12-20 09:00:00")))!.rooms[0].canCheckIn).toBe(true);
  });

  it("offers check-out, extension and then settlement during the stay", async () => {
    const q = await quoteBooking(db, FRONT_DESK, { cus_id: "1002", discount_type: "NONE", stays: [{ room_no: "205", check_in_date: "2027-03-01", check_out_date: "2027-03-02" }] }, "2027-02-01");
    const b = await createBooking(db, FRONT_DESK, { cus_id: "1002", discount_type: "NONE", stays: [{ room_no: "205", check_in_date: "2027-03-01", check_out_date: "2027-03-02" }], pay_method: "Cash", pay_amt: (q.dueCents / 100).toFixed(2) }, "2027-02-01");
    const rr = Number((await db.query("SELECT res_room_id FROM bookinn.reservation_room WHERE res_id = $1", [b.resId])).rows[0].res_room_id);
    await checkInRoom(db, FRONT_DESK, rr, at("2027-03-01 14:00:00"));
    const during = await reservationView(db, FRONT_DESK, b.resId, at("2027-03-01 15:00:00"));
    expect(during).toMatchObject({ status: "Checked-In", canModify: false, canCancel: false, roomsCheckedIn: 1 });
    expect(during!.rooms[0]).toMatchObject({ canCheckOut: true, canExtend: true, actual_check_in: "2027-03-01 14:00" });
    await db.query("INSERT INTO bookinn.adjustment_charge (res_id, charge_type, charge_amt) VALUES ($1, 'Modification', 500)", [b.resId]);
    await checkOutRoom(db, FRONT_DESK, rr, at("2027-03-02 11:00:00"));
    expect(await reservationView(db, FRONT_DESK, b.resId, at("2027-03-02 11:01:00"))).toMatchObject({ canSettle: true, unpaidCents: 50_000, unpaidCount: 1 });
    expect(await reservationView(db, FINANCE, b.resId, at("2027-03-02 11:01:00"))).toMatchObject({ canSettle: false });
  });
});

describe("room types and views (Table 26)", () => {
  it("lets only the administrator add a value, which can then be used for a new room type", async () => {
    await expect(addRoomOption(db, FRONT_DESK, "room_type", "Suite")).rejects.toMatchObject({ code: "forbidden" });
    await expect(addRoomOption(db, ADMIN, "room_type", "Suite'; DROP TABLE x; --")).rejects.toMatchObject({ code: "validation" });
    await expect(addRoomOption(db, ADMIN, "room_view", "pool view")).rejects.toMatchObject({ code: "conflict" });
    await addRoomOption(db, ADMIN, "room_type", "Suite");
    await addRoomOption(db, ADMIN, "room_view", "Mountain  View");
    expect(await enumValues(db, "room_type_t")).toEqual(["Standard", "Deluxe", "Suite"]);
    expect(await enumValues(db, "room_view_t")).toContain("Mountain View");
    await createRow(db, ADMIN, "room_details", { room_type_id: "RT03", room_type: "Suite", room_price: "5000", room_view: "Mountain View" });
    await expect(createRow(db, ADMIN, "room_details", { room_type_id: "RT04", room_type: "Penthouse", room_price: "9000", room_view: "City View" })).rejects.toMatchObject({
      code: "validation", message: "Choose one of the listed values.",
    });
    const fields = await buildFormFields(db, ADMIN, ENTITIES.room_details, "create");
    expect(fields.find((f) => f.name === "room_type")!.options!.map((o) => o.value)).toContain("Suite");
  });

  it("shows ROOM_PRICE read-only on the edit form and ignores a submitted price", async () => {
    const fields = await buildFormFields(db, ADMIN, ENTITIES.room_details, "update", { room_type_id: "RT01", room_type: "Standard", room_price: "1500.00", room_view: "Ocean View" });
    expect(fields.find((f) => f.name === "room_price")).toMatchObject({ readOnly: true, value: "1500.00" });
    const r = await updateRow(db, ADMIN, "room_details", "RT01", { room_type: "Standard", room_price: "1", room_view: "Ocean View" });
    expect(r.room_price).toBe("1500.00");
  });
});

describe("lists show short names and the reservation's rooms and stay (no repeated guest email)", () => {
  it("reservation rows carry the guest's name only, plus Rooms and Stay columns", async () => {
    const r = await getRow(db, ADMIN, "reservation", 1001);
    expect(r).toMatchObject({ cus_id__label: "JUAN DELA CRUZ", rooms: "205, 206", stay: "2026-06-25 → 2026-06-28" });
    const page = await pageRows(db, FINANCE, "reservation", { limit: 50 });
    expect(page.rows.every((x) => !String(x.cus_id__label).includes("@"))).toBe(true);
    // Search still matches the guest's email through the full label.
    expect((await pageRows(db, ADMIN, "reservation", { q: "kdpalvarado@gmail.com" })).rows.map((x) => x.res_id)).toContain(1002);
    // Computed columns cannot be used to filter or sort.
    await expect(pageRows(db, ADMIN, "reservation", { filters: { rooms: "205" } })).rejects.toMatchObject({ code: "validation" });
    expect((await pageRows(db, ADMIN, "reservation", { sort: "stay" })).sort).toBe("res_id");
  });

  it("dropdowns keep the full label so guests with the same name can be told apart", async () => {
    const opts = await refOptions(db, FRONT_DESK, "customer");
    expect(opts.find((o) => o.value === "1001")?.label).toBe("JUAN DELA CRUZ <jdcruz@gmail.com>");
  });
});

describe("dashboard trends", () => {
  it("counts bookings (Initial payments), payments and cancellations per day for the last 7 days", async () => {
    const t = await dashboardTrends(db, FINANCE, "2026-10-21");
    expect(t.days.map((d) => d.date)).toEqual(["2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21"]);
    expect(t.days.find((d) => d.date === "2026-10-20")).toMatchObject({ bookings: 1, paymentsCents: 300_000, cancellations: 0 }); // demo payment 1005
    expect(t).toMatchObject({ bookings7: 1, payments7Cents: 300_000 });
    const sep = await dashboardTrends(db, FINANCE, "2026-09-15");
    expect(sep.days.at(-1)).toMatchObject({ date: "2026-09-15", cancellations: 1 }); // cancellation 9001
    expect(sep.days.find((d) => d.date === "2026-09-11")).toMatchObject({ bookings: 1, paymentsCents: 600_000 }); // payment 1003
  });

  it("counts today's arrivals and departures from the reserved rooms and their check-in/out events", async () => {
    const t = await dashboardTrends(db, FINANCE, "2026-06-25");
    expect(t).toMatchObject({ arrivalsToday: 2, arrivalsCheckedIn: 2 }); // 1001: rooms 205 and 206
    const out = await dashboardTrends(db, FINANCE, "2026-06-27");
    expect(out).toMatchObject({ departuresToday: 1, departuresCheckedOut: 1 }); // room 206
  });
});

describe("dashboard counts and availability use check-in and check-out events", () => {
  it("counts Checked-In rooms and blocks a room that is still checked in past its check-out date", async () => {
    const s = await dashboardStats(db, FINANCE, "2027-03-01");
    expect(s).toHaveProperty("checkedIn");
    expect(s).toHaveProperty("noShow");
    const q = await quoteBooking(db, FRONT_DESK, { cus_id: "1001", discount_type: "NONE", stays: [{ room_no: "406", check_in_date: "2027-04-01", check_out_date: "2027-04-02" }] }, "2027-03-20");
    const b = await createBooking(db, FRONT_DESK, { cus_id: "1001", discount_type: "NONE", stays: [{ room_no: "406", check_in_date: "2027-04-01", check_out_date: "2027-04-02" }], pay_method: "Cash", pay_amt: (q.dueCents / 100).toFixed(2) }, "2027-03-20");
    const rr = Number((await db.query("SELECT res_room_id FROM bookinn.reservation_room WHERE res_id = $1", [b.resId])).rows[0].res_room_id);
    await checkInRoom(db, FRONT_DESK, rr, at("2027-04-01 14:00:00"));
    expect((await dashboardStats(db, FINANCE, "2027-04-01")).inHouse).toBe(1);
    // 2027-04-03: past check-out, still checked in → room 406 is taken tonight.
    const tonight = await roomAvailability(db, FRONT_DESK, "2027-04-03", "2027-04-04", "2027-04-03");
    expect(tonight.find((r) => r.room_no === 406)).toMatchObject({ available: false, blocked_by: b.resId });
  });
});
