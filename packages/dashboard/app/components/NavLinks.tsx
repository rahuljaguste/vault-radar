"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/", label: "catalog" },
  { href: "/universe", label: "ranking" },
  { href: "/portfolio", label: "scan" },
  { href: "/verify", label: "verify" },
  { href: "/docs", label: "docs" },
  { href: "/admin", label: "metrics" },
];

/**
 * The site nav, with the current page marked. A client component for `usePathname`
 * only; the links themselves are plain `next/link`, so navigation is still instant.
 */
export function NavLinks() {
  const pathname = usePathname();
  return (
    <nav className="flex flex-wrap items-center gap-1 text-sm">
      {LINKS.map((l) => {
        const active = l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
        return (
          <Link
            key={l.href}
            href={l.href}
            className={cn(
              "rounded-md px-2.5 py-1.5 no-underline transition-colors",
              active
                ? "bg-secondary font-medium text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
