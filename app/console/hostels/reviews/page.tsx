"use client";

import { ConsoleSessionGate } from "@/components/admin/ConsoleSessionGate";
import { ConsoleShell } from "@/components/console/ConsoleShell";
import { ConsoleUnavailable } from "@/components/console/ConsoleUnavailable";
import { HostelReviewsPanel } from "@/components/console/hostel/HostelReviewsPanel";

/**
 * Resident reviews for hostel buildings. A landlord answers what was said
 * about their own buildings; staff read every review and can hide one, which
 * is the only way a published score ever changes.
 */
export default function HostelReviewsPage() {
  return <ConsoleSessionGate label="hostel reviews">
    {(session) => ["LANDLORD", "ADMIN", "MODERATOR"].includes(session.account.role)
      ? <ConsoleShell
        session={session}
        service="hostels"
        label="ACCOMMODATION · REVIEWS"
        title="Resident reviews"
        blurb="What residents said about the buildings, and the answer the hostel gave."
      >
        <HostelReviewsPanel role={session.account.role} />
      </ConsoleShell>
      : <ConsoleUnavailable session={session} service="hostels" label="RESIDENT REVIEWS" blurb="Reviews are read by the hostel and platform staff." />}
  </ConsoleSessionGate>;
}
