"use client";

import Link from "next/link";
import { DockIcon, type DockGlyph } from "./DockIcon";

export type DockItem = {
  id: string;
  label: string;
  icon: DockGlyph;
  active?: boolean;
  href?: string;
  onSelect?: () => void;
};

export function FloatingDock({ items, label = "Page navigation" }: { items: DockItem[]; label?: string }) {
  return <nav className="app-floating-dock" aria-label={label}>
    {items.map(item => {
      const content = <><span className="app-dock-icon"><DockIcon name={item.icon} /></span><span className="app-dock-label">{item.label}</span></>;
      return item.href
        ? <Link key={item.id} href={item.href} aria-current={item.active ? "page" : undefined} className={item.active ? "is-active" : undefined}>{content}</Link>
        : <button key={item.id} type="button" onClick={item.onSelect} aria-pressed={item.active || undefined} className={item.active ? "is-active" : undefined}>{content}</button>;
    })}
  </nav>;
}
