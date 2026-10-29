import { requireStaff } from "@/lib/session";
import { DBA, ENTITIES, can, type EntityKey } from "@/lib/entities";
import { logoutAction } from "@/app/actions";
import { MobileMenu, NavLinks, type NavItem } from "@/components/nav";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const staff = await requireStaff();
  const link = (k: EntityKey): NavItem[] => (can(staff.role, ENTITIES[k], "read") ? [{ href: `/${k}`, label: ENTITIES[k].plural }] : []);
  const groups = [
    {
      items: [
        { href: "/", label: "Dashboard" },
        ...(can(staff.role, ENTITIES.reservation, "create") ? [{ href: "/book", label: "New booking" }] : []),
      ],
    },
    { title: "Front office", items: [...link("reservation"), ...link("customer"), ...link("loyalty_acc"), ...link("cancellation")] },
    { title: "Rooms", items: [...link("room"), ...link("room_details")] },
    { title: "Payments", items: [...link("payment"), ...link("receipt")] },
    ...(staff.role === DBA ? [{ title: "Administration", items: [...link("staff"), ...link("audit_trail"), ...link("reservation_room")] }] : []),
  ].filter((g) => g.items.length > 0);

  return (
    <div className="min-h-screen md:grid md:grid-cols-[15rem_1fr]">
      <a href="#content" className="sr-only-focusable">
        Skip to content
      </a>
      <div className="bg-brand-900">
        <nav aria-label="Main" className="relative px-3 py-5 text-white md:sticky md:top-0 md:max-h-screen md:overflow-y-auto">
          <p className="mb-1 px-3 text-xl font-bold tracking-tight">BookInn</p>
          <p className="mb-5 px-3 text-xs text-brand-200">Hotel reservations</p>
          <MobileMenu>
            <div className="mb-5 rounded-lg bg-brand-800 px-3 py-2 text-sm">
              <p className="font-medium">{staff.name}</p>
              <p className="text-xs text-brand-200">{staff.role}</p>
            </div>
            <NavLinks groups={[...groups, { title: "Account", items: [{ href: "/account", label: "Account settings" }] }]} />
            <form action={logoutAction} className="px-3">
              <button type="submit" className="btn w-full border-brand-400 text-white hover:bg-brand-800">
                Sign out
              </button>
            </form>
          </MobileMenu>
        </nav>
      </div>
      <main id="content" className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8 md:py-8">
        {children}
      </main>
    </div>
  );
}
