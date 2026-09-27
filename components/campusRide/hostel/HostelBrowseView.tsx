"use client";

import { useState, type ReactNode } from "react";
import { DeferredHostelMap } from "./DeferredHostelMap";
import type { HostelMapProperty } from "./HostelMap";
import { HostelChoicesPanel, HostelChoicesProvider } from "./HostelChoices";

export function HostelBrowseView({ children, properties, periodId }: { children: ReactNode; properties: HostelMapProperty[]; periodId: string }) {
  const [view, setView] = useState<"list" | "map">("list");
  return <HostelChoicesProvider periodId={periodId}><div className="hostel-browse-view">
    <HostelChoicesPanel />
    <div className="hostel-view-switch" role="group" aria-label="Results view">
      <button type="button" aria-pressed={view === "list"} onClick={() => setView("list")}>List</button>
      <button type="button" aria-pressed={view === "map"} onClick={() => setView("map")}>Map</button>
    </div>
    <div hidden={view !== "list"}>{children}</div>
    {view === "map" && <><DeferredHostelMap properties={properties} periodId={periodId} /><p className="hostel-detail-note">Showing up to 60 matching hostels with locations. Browse the list for all results. Distances are approximate, not walking routes.</p></>}
  </div></HostelChoicesProvider>;
}
