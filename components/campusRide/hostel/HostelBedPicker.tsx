"use client";

import { useState } from "react";
import type { PublicSpace } from "@/lib/hostel-engine/listings";
import { HostelBookButton } from "./HostelBookButton";
import { cedis } from "./format";

export function HostelBedPicker({ spaces, periodName, bookingReady }: { spaces: PublicSpace[]; periodName: string; bookingReady: boolean }) {
  const [selectedId, setSelectedId] = useState("");
  const selected = spaces.find(bed => bed.listingId === selectedId);
  const rooms = new Map<string, PublicSpace[]>();
  spaces.forEach(space => { const beds = rooms.get(space.roomLabel) || []; beds.push(space); rooms.set(space.roomLabel, beds); });
  return <section className="hostel-rooms" aria-labelledby="hostel-rooms-title">
    <div className="hostel-results-head"><h2 id="hostel-rooms-title">Choose your room and bed</h2><span>Prices for {periodName}</span></div>
    <p className="hostel-detail-note">Select a bed to review the total. {bookingReady ? "Your ten-minute hold starts when you continue to payment." : "Booking is paused while the hostel's payout details are reviewed."}</p>
    <fieldset className="hostel-bed-options"><legend className="hostel-sr-only">Available beds</legend>
      {[...rooms].map(([label, beds]) => <div key={label} className="hostel-room"><header><strong>{label}</strong><span>{beds.length} of {beds[0].capacity} student bed spaces available · {beds[0].bedLayout === "BUNK" ? `${beds[0].capacity / 2} bunk unit${beds[0].capacity === 2 ? "" : "s"}` : "separate beds"}</span></header>
        {beds.map(bed => <label key={bed.listingId} className={`hostel-bed-option${selectedId === bed.listingId ? " is-selected" : ""}`}>
          <input type="radio" name="hostel-bed" value={bed.listingId} checked={selectedId === bed.listingId} onChange={() => setSelectedId(bed.listingId)} />
          <span><strong>{bed.spaceLabel || "Bed"}</strong><small>{bed.bedLayout === "BUNK" ? "One place in a bunk" : "Separate bed"} · room of {bed.capacity} students</small></span>
          <span className="hostel-bed-price"><strong>{cedis(bed.total)}</strong><small>{bed.utilitiesFee > 0 ? `Includes ${cedis(bed.utilitiesFee)} utilities` : "Rent only"}</small></span>
        </label>)}
      </div>)}
    </fieldset>
    {selected && <div className="hostel-checkout-summary" role="region" aria-label="Selected bed">
      <div aria-live="polite"><strong>{selected.spaceLabel || "Bed"} · {selected.roomLabel}</strong><span>{cedis(selected.price)} rent + {cedis(selected.utilitiesFee)} utilities</span><b>{cedis(selected.total)} <small>total / academic year</small></b></div>
      {bookingReady ? <HostelBookButton key={selected.listingId} listingId={selected.listingId} bedLabel={`${selected.spaceLabel || "bed"} in ${selected.roomLabel}`} /> : <span className="hostel-booking-paused">Booking paused · check back after payout review</span>}
    </div>}
  </section>;
}
