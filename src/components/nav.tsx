"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";

/** On phones the menu is collapsed behind a button; on md+ screens it is always shown. */
export function MobileMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const path = usePathname();
  const [lastPath, setLastPath] = useState(path);
  if (path !== lastPath) {
    // Close after navigating (state adjusted during render, per React guidance).
    setLastPath(path);
    setOpen(false);
  }
  return (
    <>
      <button
        type="button"
        className="btn absolute right-3 top-4 border-brand-400 text-white md:hidden"
        aria-expanded={open}
        aria-controls="main-menu"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? "Close" : "Menu"}
      </button>
      <div id="main-menu" className={`${open ? "block" : "hidden"} md:block`}>
        {children}
      </div>
    </>
  );
}

export interface NavItem {
  href: string;
  label: string;
}

/** Sidebar links; highlights the current section. Which links appear is decided on the server. */
export function NavLinks({ groups }: { groups: { title?: string; items: NavItem[] }[] }) {
  const path = usePathname();
  const active = (href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`));
  return (
    <>
      {groups.map((g, i) => (
        <div key={i} className="mb-4">
          {g.title && <p className="mb-1 px-3 text-xs font-semibold uppercase tracking-wide text-brand-300">{g.title}</p>}
          <ul className="space-y-0.5">
            {g.items.map((it) => (
              <li key={it.href}>
                <Link
                  href={it.href}
                  aria-current={active(it.href) ? "page" : undefined}
                  className={`block rounded-md border-l-4 px-3 py-1.5 text-sm no-underline transition-colors hover:no-underline ${
                    active(it.href)
                      ? "border-brand-400 bg-brand-800 font-medium text-white"
                      : "border-transparent text-brand-100 hover:bg-brand-800/60 hover:text-white"
                  }`}
                >
                  {it.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}
