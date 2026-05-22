import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ollive Chat",
  description:
    "Multi-provider chatbot with real-time inference logging and observability dashboards.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-ink-950 text-ink-50 font-sans antialiased">
        <header className="border-b border-ink-800 bg-ink-950/80 backdrop-blur sticky top-0 z-30">
          <div className="mx-auto flex max-w-[1400px] items-center justify-between px-4 py-3">
            <Link href="/" className="flex items-center gap-2 text-lg font-semibold">
              <span className="inline-block h-6 w-6 rounded bg-brand-500" />
              <span>Ollive</span>
              <span className="text-ink-400 font-normal text-sm">/ chat + observability</span>
            </Link>
            <nav className="flex items-center gap-1 text-sm">
              <NavLink href="/chat">Chat</NavLink>
              <NavLink href="/dashboard">Dashboard</NavLink>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-[1400px] px-4 py-6">{children}</main>
      </body>
    </html>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded px-3 py-1.5 text-ink-200 transition hover:bg-ink-800 hover:text-ink-50"
    >
      {children}
    </Link>
  );
}
