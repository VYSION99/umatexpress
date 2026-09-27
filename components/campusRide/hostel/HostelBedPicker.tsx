"use client";

import { useState } from "react";
import type { PublicSpace } from "@/lib/hostel-engine/listings";
import { HostelBookButton } from "./HostelBookButton";
import { cedis } from "./format";

export function HostelBedPicker({ spaces, periodName }: { spaces: PublicSpace[]; periodName: string }) {
  const [selectedId, setSelectedId] = useState("");
  const selected = spaces.find(bed => bed.listingId === selectedId);
  const rooms = new Map<string, PublicSpace[]>();
  spaces.forEach(space => { const beds = rooms.get(space.roomLabel) || []; beds.push(space); rooms.set(space.roomLabel, beds); });
  return <section className="hostel-rooms" aria-labelledby="hostel-rooms-title">
    <div className="hostel-results-head"><h2 id="hostel-rooms-title">Choose your room and bed</h2><span>Prices for {periodName}</span></div>
    <p className="hostel-detail-note">Select a bed to review the total. Your ten-minute hold starts when you continue to payment.</p>
    <fieldset className="hostel-bed-options"><legend className="hostel-sr-only">Available beds</legend>
      {[...rooms].map(([label, beds]) => <div key={label} className="hostel-room"><header><strong>{label}</strong><span>{beds.length} of {beds[0].capacity} beds available</span></header>
        {beds.map(bed => <label key={bed.listingId} className={`hostel-bed-option${selectedId === bed.listingId ? " is-selected" : ""}`}>
          <input type="radio" name="hostel-bed" value={bed.listingId} checked={selectedId === bed.listingId} onChange={() => setSelectedId(bed.listingId)} />
          <span><strong>{bed.spaceLabel || "Bed"}</strong><small>Room of {bed.capacity} · one student</small></span>
          <span className="hostel-bed-price"><strong>{cedis(bed.total)}</strong><small>{bed.utilitiesFee > 0 ? `Includes ${cedis(bed.utilitiesFee)} utilities` : "Rent only"}</small></span>
        </label>)}
      </div>)}
    </fieldset>
    {selected && <div className="hostel-checkout-summary" role="region" aria-label="Selected bed">
      <div aria-live="polite"><strong>{selected.spaceLabel || "Bed"} · {selected.roomLabel}</strong><span>{cedis(selected.price)} rent + {cedis(selected.utilitiesFee)} utilities</span><b>{cedis(selected.total)} <small>total / academic year</small></b></div>
      <HostelBookButton key={selected.listingId} listingId={selected.listingId} bedLabel={`${selected.spaceLabel || "bed"} in ${selected.roomLabel}`} />
    </div>}
  </section>;
}
