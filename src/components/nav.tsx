"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Icon, type IconName } from "./icons";

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
        <Icon name={open ? "close" : "menu"} size={16} /> {open ? "Close" : "Menu"}
      </button>
      <div id="main-menu" className={`${open ? "block animate-in" : "hidden"} md:block`}>
        {children}
      </div>
    </>
  );
}

export interface NavItem {
  href: string;
  label: string;
  icon: IconName;
}

/** Sidebar links with icons; highlights the current section. Which links appear is decided on the server. */
export function NavLinks({ groups }: { groups: { title?: string; items: NavItem[] }[] }) {
  const path = usePathname();
  const active = (href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`));
  return (
    <>
      {groups.map((g, i) => (
        <div key={i} className="mb-4">
          {g.title && <p className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-wider text-brand-300">{g.title}</p>}
          <ul className="space-y-0.5">
            {g.items.map((it) => {
              const on = active(it.href);
              return (
                <li key={it.href}>
                  <Link
                    href={it.href}
                    aria-current={on ? "page" : undefined}
                    className={`nav-link group flex items-center gap-3 rounded-lg px-3 py-2 text-sm no-underline hover:no-underline ${
                      on ? "bg-white font-medium text-brand-900 shadow-sm" : "text-brand-100 hover:bg-brand-800 hover:text-white"
                    }`}
                  >
                    <Icon name={it.icon} size={18} className={on ? "text-brand-800" : "text-brand-300 group-hover:text-white"} />
                    <span>{it.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </>
  );
}
