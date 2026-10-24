"use client";

import { useId } from "react";

export type DockGlyph = "home" | "services" | "car" | "bus" | "bed" | "film" | "food" | "ticket" | "account" | "shield";

/** Small dimensional SVG illustrations shared by every floating dock. */
export function DockIcon({ name, size = 29 }: { name: DockGlyph; size?: number }) {
  const id = useId().replace(/:/g, "");
  const green = `dock-green-${id}`;
  const gold = `dock-gold-${id}`;
  const pale = `dock-pale-${id}`;
  return <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id={green} x1="5" y1="4" x2="27" y2="29" gradientUnits="userSpaceOnUse"><stop stopColor="#52B78E"/><stop offset=".52" stopColor="#177658"/><stop offset="1" stopColor="#07452F"/></linearGradient>
      <linearGradient id={gold} x1="8" y1="3" x2="24" y2="29" gradientUnits="userSpaceOnUse"><stop stopColor="#FFE69A"/><stop offset=".55" stopColor="#DDAE45"/><stop offset="1" stopColor="#9D6921"/></linearGradient>
      <linearGradient id={pale} x1="4" y1="4" x2="28" y2="27" gradientUnits="userSpaceOnUse"><stop stopColor="#FFFFFF"/><stop offset="1" stopColor="#DDEFE3"/></linearGradient>
    </defs>
    {name === "home" && <><path d="M3 14.5 16 4l13 10.5-2 3-11-8.8L5 17.5z" fill={`url(#${green})`} stroke="#07513A" strokeWidth="1.2"/><path d="M6.5 15.3 16 8l9.5 7.3V27H6.5z" fill={`url(#${pale})`} stroke="#0B5D43" strokeWidth="1.3"/><path d="M13 27v-9h6v9" fill={`url(#${gold})`} stroke="#84591D" strokeWidth="1.1"/><path d="m9 15 7-5.5 7 5.5" stroke="#fff" strokeOpacity=".8" strokeWidth="1.3"/></>}
    {name === "services" && <><rect x="4" y="4" width="11" height="11" rx="3" fill={`url(#${green})`} stroke="#07513A"/><rect x="17" y="4" width="11" height="11" rx="3" fill={`url(#${pale})`} stroke="#0B5D43"/><rect x="4" y="17" width="11" height="11" rx="3" fill={`url(#${pale})`} stroke="#0B5D43"/><rect x="17" y="17" width="11" height="11" rx="3" fill={`url(#${gold})`} stroke="#966A29"/><path d="M7 7h5M20 7h5M7 20h5M20 20h5" stroke="#fff" strokeOpacity=".78" strokeWidth="1.4" strokeLinecap="round"/></>}
    {name === "car" && <><path d="m7 16 2-6c.4-1.2 1.4-2 2.7-2h8.6c1.3 0 2.3.8 2.7 2l2 6" fill={`url(#${pale})`} stroke="#0B5D43" strokeWidth="1.2"/><path d="M5 15.5h22a2 2 0 0 1 2 2V24H3v-6.5a2 2 0 0 1 2-2Z" fill={`url(#${green})`} stroke="#07513A" strokeWidth="1.3"/><path d="M10 10.5h12l1.5 5H8.5z" fill="#BCE8DB" stroke="#23785D" strokeWidth=".8"/><path d="M6 19h4m12 0h4" stroke="#F5E5AE" strokeWidth="2" strokeLinecap="round"/><circle cx="9" cy="25" r="2.3" fill="#253D34"/><circle cx="23" cy="25" r="2.3" fill="#253D34"/></>}
    {name === "bus" && <><rect x="6" y="3.5" width="20" height="24" rx="4" fill={`url(#${green})`} stroke="#07513A" strokeWidth="1.3"/><rect x="8.5" y="7" width="15" height="9" rx="2" fill="#D7F3E9" stroke="#5AB499"/><path d="M9 20h5m4 0h5" stroke="#F9E8B7" strokeWidth="2" strokeLinecap="round"/><path d="M10 4.8h12" stroke="#fff" strokeOpacity=".75" strokeWidth="1.4" strokeLinecap="round"/><circle cx="10" cy="26" r="2" fill="#263C33"/><circle cx="22" cy="26" r="2" fill="#263C33"/></>}
    {name === "bed" && <><path d="M5 8a2 2 0 0 1 2-2h2v20H5z" fill={`url(#${green})`} stroke="#07513A"/><rect x="9" y="13" width="19" height="10" rx="2" fill={`url(#${gold})`} stroke="#9D6921"/><path d="M10 16h16v5H10z" fill={`url(#${pale})`} stroke="#B6D7C5"/><rect x="10" y="12" width="7" height="4" rx="1.5" fill="#fff" stroke="#BDD7CA"/><path d="M5 25h23M27 23v3" stroke="#07513A" strokeWidth="2" strokeLinecap="round"/></>}
    {name === "film" && <><rect x="5" y="11" width="22" height="17" rx="2.5" fill={`url(#${green})`} stroke="#07513A" strokeWidth="1.3"/><path d="M6 5.5 24 2l2 7-18 3.5z" fill={`url(#${pale})`} stroke="#07513A" strokeWidth="1.1"/><path d="m11 4.5 4 5m3-6 4 5" stroke="#23785D" strokeWidth="2"/><path d="m14 15.5 7 4.3-7 4.3z" fill={`url(#${gold})`} stroke="#9D6921"/></>}
    {name === "food" && <><path d="M5 17a11 11 0 0 0 22 0Z" fill={`url(#${green})`} stroke="#07513A" strokeWidth="1.3"/><path d="M4 17h24" stroke="#B5D9C4" strokeWidth="2" strokeLinecap="round"/><path d="M10 13c0-2 2-2 2-4m5 4c0-2 2-2 2-4" stroke="#DDAE45" strokeWidth="1.6" strokeLinecap="round"/><path d="M11 27h10" stroke="#07513A" strokeWidth="2" strokeLinecap="round"/></>}
    {name === "ticket" && <><path d="M5 7h22v7a3 3 0 0 0 0 6v5H5v-5a3 3 0 0 0 0-6z" fill={`url(#${gold})`} stroke="#94611F" strokeWidth="1.3"/><path d="M12 7v18" stroke="#fff5d9" strokeWidth="1.5" strokeDasharray="2 2"/><path d="M17 13h6m-6 4h5" stroke="#6A4D1F" strokeWidth="1.5" strokeLinecap="round"/></>}
    {name === "account" && <><circle cx="16" cy="11" r="6" fill={`url(#${gold})`} stroke="#94611F" strokeWidth="1.2"/><path d="M5 27c0-6 4.5-9 11-9s11 3 11 9Z" fill={`url(#${green})`} stroke="#07513A" strokeWidth="1.3"/><path d="M10 22c2-1.2 4-1.8 6-1.8s4 .6 6 1.8" stroke="#B8E1CE" strokeWidth="1.5" strokeLinecap="round"/></>}
    {name === "shield" && <><path d="M16 3 27 7v8c0 7-4.5 11.3-11 14-6.5-2.7-11-7-11-14V7z" fill={`url(#${green})`} stroke="#07513A" strokeWidth="1.3"/><path d="m11 16 3.2 3.2L21.5 12" stroke="#FBE5A0" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M8 9 16 6l8 3" stroke="#fff" strokeOpacity=".65" strokeWidth="1.2" strokeLinecap="round"/></>}
  </svg>;
}
