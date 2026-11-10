import { requireStaff } from "@/lib/session";
import { DBA, ENTITIES, FIN, can, type EntityKey } from "@/lib/entities";
import { logoutAction } from "@/app/actions";
import { MobileMenu, NavLinks, type NavItem } from "@/components/nav";
import { Icon, type IconName } from "@/components/icons";

const ICONS: Partial<Record<EntityKey, IconName>> = {
  reservation: "bookings",
  customer: "guest",
  loyalty_acc: "loyalty",
  cancellation: "cancellation",
  room: "rooms",
  room_details: "roomTypes",
  payment: "payments",
  receipt: "receipts",
  adjustment_charge: "charges",
  refund: "refunds",
  staff: "staff",
  audit_trail: "audit",
  reservation_room: "reservedRooms",
};

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const staff = await requireStaff();
  const link = (k: EntityKey): NavItem[] =>
    can(staff.role, ENTITIES[k], "read") ? [{ href: `/${k}`, label: ENTITIES[k].plural, icon: ICONS[k] ?? "dashboard" }] : [];
  const groups = [
    {
      items: [
        { href: "/", label: "Dashboard", icon: "dashboard" as IconName },
        ...(can(staff.role, ENTITIES.reservation, "create") ? [{ href: "/book", label: "New booking", icon: "booking" as IconName }] : []),
      ],
    },
    { title: "Front office", items: [...link("reservation"), ...link("customer"), ...link("loyalty_acc"), ...link("cancellation")] },
    { title: "Rooms", items: [...link("room"), ...link("room_details")] },
    {
      title: "Payments",
      items: [
        ...link("payment"),
        ...link("receipt"),
        ...link("adjustment_charge"),
        ...link("refund"),
        ...(staff.role === FIN || staff.role === DBA ? [{ href: "/overdue", label: "Overdue", icon: "overdue" as IconName }] : []),
      ],
    },
    ...(staff.role === DBA ? [{ title: "Administration", items: [...link("staff"), ...link("audit_trail"), ...link("reservation_room")] }] : []),
  ].filter((g) => g.items.length > 0);
  const initials = staff.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

  return (
    <div className="min-h-screen md:grid md:grid-cols-[15.5rem_1fr]">
      <a href="#content" className="sr-only-focusable">
        Skip to content
      </a>
      <div className="bg-brand-900">
        <nav aria-label="Main" className="relative px-3 py-5 text-white md:sticky md:top-0 md:max-h-screen md:overflow-y-auto">
          <div className="mb-5 flex items-center gap-2.5 px-3">
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600/30 text-white ring-1 ring-brand-400/40">
              <Icon name="bed" size={20} />
            </span>
            <span>
              <span className="block text-lg font-bold leading-tight tracking-tight">BookInn</span>
              <span className="block text-xs text-brand-200">Hotel reservations</span>
            </span>
          </div>
          <MobileMenu>
            <div className="mb-5 flex items-center gap-3 rounded-lg bg-brand-800 px-3 py-2.5 text-sm">
              <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-600/40 text-xs font-semibold">{initials}</span>
              <span className="min-w-0">
                <span className="block truncate font-medium">{staff.name}</span>
                <span className="block text-xs text-brand-200">{staff.role}</span>
              </span>
            </div>
            <NavLinks groups={[...groups, { title: "Account", items: [{ href: "/account", label: "Account settings", icon: "account" }] }]} />
            <form action={logoutAction} className="px-3">
              <button type="submit" className="btn w-full border-brand-400 text-white hover:bg-brand-800">
                <Icon name="logout" size={16} /> Sign out
              </button>
            </form>
          </MobileMenu>
        </nav>
      </div>
      <main id="content" className="mx-auto w-full max-w-7xl px-4 py-6 md:px-8 md:py-8">
        {children}
      </main>
    </div>
  );
}
