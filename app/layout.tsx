import type { Metadata } from "next";
import { AppInstallPrompt } from "@/components/pwa/AppInstallPrompt";
import "./globals.css";
import "./ticket.css";
import "./palette.css";

export const metadata: Metadata = {
  title: "UMaTeXPRESS | UMaT Student Transport",
  description: "Choose vacationRide for long-distance trips or campusRide for live campus transport.",
  manifest: "/manifest.webmanifest",
  applicationName: "UMaTeXPRESS",
  appleWebApp: {
    capable: true,
    title: "UMaTeXPRESS",
    statusBarStyle: "default",
  },
  themeColor: "#0d694d",
  other: { "codex-preview": "development", "mobile-web-app-capable": "yes" },
  icons: {
    icon: "/logo.svg",
    shortcut: "/logo.svg",
    apple: "/icon-192.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        {children}
        <AppInstallPrompt />
      </body>
    </html>
  );
}
