import type { Metadata } from "next";
import "./globals.css";
import "./ticket.css";

export const metadata: Metadata = {
  title: "UmateXPRESS | UMaT Vacation Transport",
  description: "VIP student transport from UMaT Main Campus to Accra.",
  other: { "codex-preview": "development" },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
