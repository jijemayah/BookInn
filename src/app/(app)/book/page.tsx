import { getDb } from "@/lib/db/pg";
import { requireStaff } from "@/lib/session";
import { refOptions } from "@/lib/crud";
import { ENTITIES, can } from "@/lib/entities";
import { hotelToday } from "@/lib/dates";
import { roomChoices } from "@/lib/reservation-view";
import { Alert, PageHeader } from "@/components/ui";
import { BookingForm } from "./booking-form";

export default async function BookPage({ searchParams }: PageProps<"/book">) {
  const staff = await requireStaff();
  const actor = { staffId: staff.staffId, role: staff.role };
  if (!can(staff.role, ENTITIES.reservation, "create")) {
    return (
      <>
        <PageHeader title="New booking" />
        <Alert kind="error">Your role ({staff.role}) cannot create reservations.</Alert>
      </>
    );
  }
  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
  const db = getDb();
  const [customers, rooms] = await Promise.all([refOptions(db, actor, "customer"), roomChoices(db)]);
  return (
    <>
      <PageHeader
        title="New booking"
        description="Choose the guest, the dates and the rooms. The Initial payment is the full amount, paid upfront."
        back={{ href: "/reservation", label: "Reservations" }}
      />
      <BookingForm
        customers={customers}
        rooms={rooms.map((r) => ({ room_no: String(r.room_no), room_type: r.room_type, room_view: r.room_view, room_price: r.room_price }))}
        today={hotelToday()}
        defaults={{ cus_id: str("cus_id"), check_in_date: str("check_in_date"), check_out_date: str("check_out_date"), room_no: str("room_no") ? [str("room_no")!] : [] }}
      />
    </>
  );
}
