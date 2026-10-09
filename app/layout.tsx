import type { Metadata } from "next";
import { AppInstallPrompt } from "@/components/pwa/AppInstallPrompt";
import "./globals.css";
import "./ticket.css";
import "./palette.css";
import "./material-icons.css";
import "./bottom-sheet.css";

// Runs before the body paints so a reload never flashes or replays the splash.
const splashReloadGuard = `try{var n=performance.getEntriesByType('navigation')[0];var r=(n&&n.type==='reload')||(performance.navigation&&performance.navigation.type===1);var s=sessionStorage.getItem('umatexpress:intro-played:v1')==='1';if(r)document.documentElement.classList.add('page-is-reloading');if(r||s)document.documentElement.classList.add('splash-already-seen')}catch(e){}`;

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
    icon: [
      { url: "/favicon.ico", sizes: "any", type: "image/x-icon" },
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    shortcut: "/favicon.ico",
    apple: "/apple-touch-icon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head><script dangerouslySetInnerHTML={{ __html: splashReloadGuard }} /></head>
      <body className="antialiased">
        {children}
        <AppInstallPrompt />
      </body>
    </html>
  );
}
