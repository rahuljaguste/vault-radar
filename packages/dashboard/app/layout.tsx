import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { NavLinks } from "@/app/components/NavLinks";
import "./globals.css";

export const metadata: Metadata = {
  title: "VaultRadar",
  description: "Cross-protocol vault risk, metered over x402, sealed with PQ KEM, receipts signed with ML-DSA-65.",
};

/* The browser chrome matches the deck's ink, which is also the page's only scheme. */
export const viewport: Viewport = {
  themeColor: "#0b1220",
};

function BrandMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 64 64" aria-hidden="true" className="shrink-0">
      <rect width="64" height="64" rx="14" fill="var(--card)" />
      <rect x="0.5" y="0.5" width="63" height="63" rx="13.5" fill="none" stroke="var(--border)" />
      <g fill="none" stroke="var(--brand)">
        <circle cx="32" cy="37" r="20" strokeOpacity="0.28" />
        <circle cx="32" cy="37" r="13" strokeOpacity="0.5" />
        <circle cx="32" cy="37" r="6" strokeOpacity="0.85" />
      </g>
      <circle cx="43.5" cy="24.5" r="7" fill="var(--brand)" fillOpacity="0.22" />
      <circle cx="43.5" cy="24.5" r="3.4" fill="var(--brand)" />
    </svg>
  );
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <header className="sticky top-0 z-10 border-b bg-card/80 backdrop-blur">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-8 gap-y-2 px-6 py-3.5">
            <Link
              href="/"
              className="flex items-center gap-2 text-sm font-semibold tracking-tight no-underline"
              aria-label="VaultRadar home"
            >
              <BrandMark />
              Vault<span className="text-brand">Radar</span>
            </Link>
            <NavLinks />
          </div>
        </header>
        <main className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-6 py-10">{children}</main>
        <footer className="border-t">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2 px-6 py-4 text-xs text-faint">
            <span>VaultRadar · ETHOnline 2026</span>
            <span className="font-mono">x402 · ML-DSA-65 · ERC-8004</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
