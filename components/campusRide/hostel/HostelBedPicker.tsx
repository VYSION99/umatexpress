"use client";

import { useState } from "react";
import type { PublicSpace } from "@/lib/hostel-engine/listings";
import { usePaymentQuote } from "@/lib/payment-quote-client";
import { HostelBookButton } from "./HostelBookButton";
import { cedis } from "./format";

export function HostelBedPicker({ spaces, periodName, bookingReady }: { spaces: PublicSpace[]; periodName: string; bookingReady: boolean }) {
  const [selectedId, setSelectedId] = useState("");
  const selected = spaces.find(bed => bed.listingId === selectedId);
  const { quote, error: quoteError } = usePaymentQuote(selected?.total || 0);
  const rooms = new Map<string, PublicSpace[]>();
  spaces.forEach(space => {
    const beds = rooms.get(space.roomId) || [];
    beds.push(space);
    rooms.set(space.roomId, beds);
  });

  if (!spaces.length) return <section className="hostel-rooms hostel-no-beds" aria-labelledby="hostel-rooms-title"><span className="hostel-section-kicker">ROOM AVAILABILITY</span><h2 id="hostel-rooms-title">Beds are being prepared</h2><p>The building is approved, but no beds have been approved for {periodName} yet. You can explore the property, request a viewing, or ask the staff a question.</p></section>;

  return <section className="hostel-rooms" aria-labelledby="hostel-rooms-title">
    <div className="hostel-results-head"><h2 id="hostel-rooms-title">Available rooms</h2><span>Prices for {periodName}</span></div>
    <details className="hostel-rooms-disclosure">
      <summary className="hostel-rooms-toggle">
        <span><strong>{rooms.size} {rooms.size === 1 ? "room" : "rooms"} available</strong><small>{spaces.length} student {spaces.length === 1 ? "bed" : "beds"} ready to choose</small></span>
        <span className="hostel-rooms-toggle-action"><span className="hostel-when-closed">View rooms</span><span className="hostel-when-open">Hide rooms</span><span className="hostel-toggle-chevron" aria-hidden="true" /></span>
      </summary>
      <div className="hostel-rooms-content">
        <p className="hostel-detail-note">Select a bed to review the total. {bookingReady ? "Your ten-minute hold starts when you continue to payment." : "Booking is paused while the hostel's payout details are reviewed."}</p>
        <fieldset className="hostel-bed-options"><legend className="hostel-sr-only">Available beds</legend>
          {[...rooms].map(([roomId, beds]) => <details key={roomId} name="hostel-room-beds" className="hostel-room hostel-room-disclosure">
            <summary className="hostel-room-toggle">
              <span className="hostel-room-toggle-info"><strong>{beds[0].roomLabel}</strong><small>{beds.length} of {beds[0].capacity} student bed spaces available · {beds[0].bedLayout === "BUNK" ? String(beds[0].capacity / 2) + " bunk " + (beds[0].capacity === 2 ? "unit" : "units") : "separate beds"}</small></span>
              <span className="hostel-room-toggle-price"><strong>{cedis(beds[0].total)}</strong><small>per bed · <span className="hostel-when-closed">View beds</span><span className="hostel-when-open">Hide beds</span></small></span>
              <span className="hostel-toggle-chevron" aria-hidden="true" />
            </summary>
            <div className="hostel-room-beds">
              {beds.map(bed => <label key={bed.listingId} className={"hostel-bed-option" + (selectedId === bed.listingId ? " is-selected" : "")}>
                <input type="radio" name="hostel-bed" value={bed.listingId} checked={selectedId === bed.listingId} onChange={() => setSelectedId(bed.listingId)} />
                <span><strong>{bed.spaceLabel || "Bed"}</strong><small>{bed.bedLayout === "BUNK" ? "One place in a bunk" : "Separate bed"} · room of {bed.capacity} students</small></span>
                <span className="hostel-bed-price"><strong>{cedis(bed.total)}</strong><small>{bed.utilitiesFee > 0 ? "Includes " + cedis(bed.utilitiesFee) + " utilities" : "Rent only"}</small></span>
              </label>)}
            </div>
          </details>)}
        </fieldset>
      </div>
    </details>
    {selected && <div className="hostel-checkout-summary" role="region" aria-label="Selected bed">
      <div aria-live="polite"><strong>{selected.spaceLabel || "Bed"} · {selected.roomLabel}</strong><span>{cedis(selected.price)} rent + {cedis(selected.utilitiesFee)} utilities</span><b>{cedis(selected.total)} <small>rent + utilities</small></b><span>Paystack processing ({quote?.feePercent ?? 1.95}%): {quote ? cedis(quote.feeAmount) : "Calculating…"}</span><b>{quote ? cedis(quote.totalAmount) : "Calculating…"} <small>total to pay</small></b>{quoteError && <span role="alert">{quoteError}</span>}</div>
      {bookingReady ? <HostelBookButton key={selected.listingId} listingId={selected.listingId} bedLabel={(selected.spaceLabel || "bed") + " in " + selected.roomLabel} feeReady={Boolean(quote)} /> : <span className="hostel-booking-paused">Booking paused · check back after payout review</span>}
    </div>}
  </section>;
}
