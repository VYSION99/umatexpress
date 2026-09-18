import type { Metadata } from "next";
import "./console.css";

export const metadata: Metadata = {
  title: "UMaTeXPRESS Console",
  description: "Sign in to the UMaTeXPRESS management console.",
  robots: { index: false, follow: false },
};

export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  return children;
}
