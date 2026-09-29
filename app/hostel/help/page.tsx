import type { Metadata } from "next";
import Link from "next/link";
import { CampusShell } from "@/components/campusRide/shared/CampusShell";
import { HostelHelpAssistant } from "@/components/campusRide/hostel/HostelHelpAssistant";
import "@/components/campusRide/hostel/hostel-help.css";

export const metadata: Metadata = {
  title: "Hostel Finder Help | UMaTeXPRESS",
  description: "How to compare hostels, book a bed, request a visit, use alerts, and understand prices and refunds.",
};

export default function HostelHelpPage() {
  return <CampusShell area="HOSTELFINDER HELP" title="Hostel Finder help" subtitle="Clear steps for finding, visiting, booking, and managing your student stay.">
    <div className="hostel-help-layout">
      <div className="hostel-help-lead"><p>STUDENT GUIDE</p><h2>Find a place with the details in front of you</h2><p>Browse approved beds without signing in. Use these steps to compare a room, ask questions, and book when you are ready.</p><div className="hostel-help-links"><Link href="/hostel">Browse hostels</Link><Link href="/hostel/resident">Open my residency</Link></div></div>
      <HostelHelpAssistant/>
      <section className="hostel-help-card"><h2>Compare hostels</h2><ol><li>Choose an open academic year. Search by name or area, then filter by distance, yearly price, available beds, or utilities.</li><li>Open a property to see approved photos, rooms and beds, prices, reviews, staff-check dates, and available travel estimates.</li><li>The card distance is a straight-line estimate. A walking route and time are shown separately when routing data is available.</li></ol><p>Browse without an account. Sign in to save a hostel, request a viewing, or book.</p></section>
      <section className="hostel-help-card"><h2>Understand the price and beds</h2><ul><li>The price is for one student bed for one academic year. Beds in the same room have the same yearly rent.</li><li>A bunk unit has a lower and an upper bed. Each is a separate bed space and requires its own booking.</li><li>The displayed total includes utilities only when the property has enabled a per-bed utilities fee. Ask about any charge that is not shown.</li><li>Each booking reserves one bed. To book two beds, submit two separate bookings while both are available.</li></ul></section>
      <section className="hostel-help-card"><h2>Visit or ask before booking</h2><p>Choose an available visit time and sign in to request it. A viewing is free and does not reserve a bed; hostel staff confirm or decline your request.</p><p>Use the property assistant for questions about one hostel. It uses the public listing and facts supplied by that hostel. If it cannot answer, send the question to staff and include an email address for their reply.</p><p>Staff-check dates show when a review record was created. Conditions can change after that check, so confirm important details with the hostel.</p></section>
      <section className="hostel-help-card"><h2>Book and pay</h2><ol><li>Choose a bed and review the annual rent, utilities, and total.</li><li>Sign in with your UMaT student account.</li><li>Select <strong>Hold this bed</strong>. You have ten minutes to finish checkout.</li><li>Complete Paystack checkout. The booking is confirmed after the payment is verified.</li></ol><p>If the hold expires before payment is complete, the bed may be released. A listing may be visible while checkout is paused for payout review.</p></section>
      <section className="hostel-help-card"><h2>Saved hostels and alerts</h2><p>Save up to 20 hostels per student account. Enable alerts to hear when a bed becomes available again or a newer academic year opens at a saved property. Alerts can take time; check the bed again before paying.</p></section>
      <section className="hostel-help-card"><h2>After your booking</h2><p>Open <Link href="/hostel/resident">My Hostel Residency</Link> with the same student account that paid. You can review the confirmed bed, contact your host, read announcements, message staff, and manage eligible service requests.</p><p>Paid stays can leave one review. Hostel staff can reply once; platform staff can hide a review with a recorded reason.</p></section>
      <section className="hostel-help-card"><h2>Refund requests</h2><p>Refund requests are reviewed by staff. The current policy quote is:</p><ul><li>30 days or more before the academic year: 100%.</li><li>7 to 29 days before the year: 50%.</li><li>Inside the final 7 days: 0%.</li></ul><p>An administrator may approve an exception with a recorded reason. An approved refund is complete after the payment settles.</p></section>
      <p className="hostel-help-lead">Availability and property details can change. Recheck the selected bed and price immediately before checkout.</p>
    </div>
  </CampusShell>;
}
