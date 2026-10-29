import { getDb } from "@/lib/db/pg";
import { requireStaff } from "@/lib/session";
import { refOptions } from "@/lib/crud";
import { ENTITIES, can } from "@/lib/entities";
import { hotelToday } from "@/lib/dates";
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
  const [customers, rooms] = await Promise.all([refOptions(db, actor, "customer"), refOptions(db, actor, "room")]);
  return (
    <>
      <PageHeader
        title="New booking"
        description="Reserve rooms and record the payment."
        back={{ href: "/reservation", label: "Reservations" }}
      />
      <BookingForm
        customers={customers}
        rooms={rooms}
        today={hotelToday()}
        defaults={{ cus_id: str("cus_id"), check_in_date: str("check_in_date"), check_out_date: str("check_out_date"), room_no: str("room_no") ? [str("room_no")!] : [] }}
      />
    </>
  );
}
