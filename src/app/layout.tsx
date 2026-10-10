import type { Metadata } from "next";
import Link from "next/link";
import { LayoutGrid, Radio } from "lucide-react";
import "./globals.css";

export const metadata: Metadata = {
  title: "TikTok Agent Control",
  description: "Autonomous TikTok account agents",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" data-theme="dark">
      <body className="min-h-screen">
        <header className="sticky top-0 z-20 border-b border-border bg-bg/85 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-6">
            <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
              <Radio className="h-4 w-4 text-series-1" />
              Agent Control
            </Link>
            <nav className="flex items-center gap-1 text-sm">
              <Link
                href="/"
                className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-ink-2 transition hover:bg-surface-2 hover:text-ink"
              >
                <LayoutGrid className="h-3.5 w-3.5" />
                Accounts
              </Link>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
