import type { PublicVerification } from "@/lib/hostel-engine/verification";
const labels: Record<PublicVerification["kind"], string> = { PHOTOS: "Photos", LOCATION: "Location", UTILITIES: "Utilities", SAFETY: "Safety details" };
export function HostelVerificationCard({ checks }: { checks: PublicVerification[] }) {
  return <section className="hostel-verification-card" aria-label="Staff-checked property details">
    <h2>What staff checked</h2>
    <p>Each date is tied to a staff review record. Details can change after a visit, so confirm what matters before booking.</p>
    {checks.length ? <ul>{checks.map(check => <li key={check.id}>
      <strong>{labels[check.kind]}</strong><span>Checked {new Date(check.checkedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</span>
      <small>{check.kind === "PHOTOS" ? `${check.photoCount} approved ${check.photoCount === 1 ? "image" : "images"}` : check.note}</small>
      <small>Review record {check.id.slice(0, 8)}</small>
    </li>)}</ul> : <p>No property details have been checked by staff yet.</p>}
  </section>;
}
