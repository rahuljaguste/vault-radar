import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "VaultRadar",
  description: "Cross-protocol vault risk, metered over x402, sealed with PQ KEM, receipts signed with ML-DSA-65.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header>
          <Link href="/">VaultRadar</Link>
          <nav>
            <Link href="/">catalog &amp; runs</Link>
            <Link href="/portfolio">scan your portfolio</Link>
            <Link href="/verify">verify a receipt</Link>
            <Link href="/admin">service metrics</Link>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
