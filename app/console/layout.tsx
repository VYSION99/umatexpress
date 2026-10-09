import type { Metadata } from "next";
import "./console.css";

export const metadata: Metadata = {
  title: "UMaTeXPRESS Console",
  description: "Sign in to the UMaTeXPRESS management console.",
  manifest: "/console-manifest.webmanifest",
  applicationName: "UMaTeXPRESS Console",
  appleWebApp: { capable: true, title: "UMaTe Console", statusBarStyle: "black-translucent" },
  themeColor: "#152337",
  icons: {
    icon: [
      { url: "/console-favicon.ico", sizes: "any", type: "image/x-icon" },
      { url: "/console-mark.svg", type: "image/svg+xml" },
      { url: "/console-icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/console-icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    shortcut: "/console-favicon.ico",
    apple: "/console-apple-touch-icon.png",
  },
  robots: { index: false, follow: false },
};

export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  return children;
}
