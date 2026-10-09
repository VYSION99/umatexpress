"use client";

import { useRef } from "react";
import type { CampusRideMatch } from "@/lib/campus-matching";
import { QueueJoinCard } from "@/components/campusRide/student/QueueJoinCard";
import { ArrowRight, Check, Clock, MapPin, Users, X } from "@/components/ui/MaterialIcon";
import { SheetHandle } from "@/components/ui/SheetHandle";

const cedis = (pesewas: number) => pesewas > 0 ? `GH₵ ${(pesewas / 100).toFixed(2)}` : "Fare not set";

export function RideMatchCard({ match, pickupZoneId, destinationZoneId, pickupLatitude, pickupLongitude, selected, onSelect }: { match: CampusRideMatch; pickupZoneId: string; destinationZoneId: string; pickupLatitude?: number; pickupLongitude?: number; selected: boolean; onSelect: () => void }) {
  const titleId = `ride-${match.id}-title`;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeDetails = () => dialogRef.current?.close();
  const chooseRide = () => { onSelect(); closeDetails(); };
  return <>
    <article className={`ride-match-card${selected ? " is-selected" : ""}`} aria-labelledby={titleId}>
      <div><span>{match.distanceLabel}</span><strong id={titleId}>{match.corridor?.name || "Campus ride"}</strong></div>
      <p>{match.vehicleLabel} {match.plateNumber ? `· ${match.plateNumber}` : ""}</p>
      <ul>
        <li>{match.driverName}</li>
        <li><Users size={14}/>{match.availableSlots} queue slots</li>
        <li><Clock size={14}/>{match.estimatedMinutes || "—"} min route</li>
        <li>{cedis(match.fare)}</li>
      </ul>
      <div className="campus-ride-card-actions">
        <button type="button" className="campus-ride-secondary" onClick={() => dialogRef.current?.showModal()}>Ride details</button>
        {!selected && <button type="button" className="ride-select-control" onClick={onSelect}>Select this ride <ArrowRight size={15} aria-hidden /></button>}
      </div>
      {selected && <div className="ride-selected-actions"><span><Check size={16}/> Selected ride</span><QueueJoinCard match={match} pickupZoneId={pickupZoneId} destinationZoneId={destinationZoneId} pickupLatitude={pickupLatitude} pickupLongitude={pickupLongitude} /></div>}
    </article>
    <dialog ref={dialogRef} className="campus-ride-dialog" aria-labelledby={`${titleId}-details`} onClick={(event) => { if (event.target === event.currentTarget) closeDetails(); }}>
      <SheetHandle onDismiss={closeDetails} />
      <div className="campus-ride-dialog-content">
        <div className="campus-ride-dialog-head"><span>RIDE DETAILS</span><button type="button" aria-label="Close ride details" onClick={closeDetails}><X size={19} aria-hidden /></button></div>
        <h2 id={`${titleId}-details`}>{match.corridor?.name || "Campus ride"}</h2>
        <p className="campus-ride-dialog-subtitle">Check the route and fare before joining its queue.</p>
        <div className="campus-ride-route"><div><small>VEHICLE ZONE</small><strong>{match.pickupZone?.name || "On route"}</strong></div><ArrowRight size={21} aria-hidden /><div><small>DESTINATION</small><strong>{match.destinationZone?.name || "Selected destination"}</strong></div></div>
        <dl className="campus-ride-detail-list"><div><dt><MapPin size={17} aria-hidden /> Vehicle proximity</dt><dd>{match.distanceLabel}</dd></div><div><dt><Clock size={17} aria-hidden /> Estimated route time</dt><dd>{match.estimatedMinutes || "—"} min</dd></div><div><dt><Users size={17} aria-hidden /> Queue spaces</dt><dd>{match.availableSlots}</dd></div><div><dt>Flat fare</dt><dd>{cedis(match.fare)}</dd></div></dl>
        <p className="campus-ride-dialog-note">Distance is an approximate straight-line estimate. Queue entry is activated after payment; it is not a selected seat.</p>
        <div className="campus-ride-dialog-actions"><button type="button" className="campus-ride-dialog-primary" onClick={chooseRide}>{selected ? "Continue with this ride" : "Select this ride"} <ArrowRight size={17} aria-hidden /></button><button type="button" onClick={closeDetails}>Keep browsing</button></div>
      </div>
    </dialog>
  </>;
}
