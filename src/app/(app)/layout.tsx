import Link from "next/link";
import { requireStaff } from "@/lib/session";
import { ENTITIES, ENTITY_KEYS, canRead } from "@/lib/entities";
import { logoutAction } from "@/app/actions";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const staff = await requireStaff();
  const visible = ENTITY_KEYS.filter((k) => canRead(staff.role, ENTITIES[k]));
  return (
    <div className="shell">
      <a href="#content" className="skip-link">
        Skip to content
      </a>
      <nav className="sidebar" aria-label="Main">
        <p className="brand">BookInn</p>
        <p className="who">
          {staff.name}
          <br />
          <span className="badge">{staff.role}</span>
        </p>
        <ul>
          <li>
            <Link href="/">Dashboard</Link>
          </li>
          {visible.map((k) => (
            <li key={k}>
              <Link href={`/${k}`}>{ENTITIES[k].plural}</Link>
            </li>
          ))}
          <li>
            <Link href="/account">My account</Link>
          </li>
        </ul>
        <form action={logoutAction}>
          <button type="submit">Sign out</button>
        </form>
      </nav>
      <main id="content">{children}</main>
    </div>
  );
}
