"use client";

import { CampusShell, CampusStatusBanner } from "@/components/campusRide/shared/CampusShell";
import { ResidentDashboard } from "@/components/campusRide/hostel/ResidentDashboard";
import { StudentAuthCard } from "@/components/account/StudentAuthCard";
import { useStudentAccount } from "@/components/account/useStudentAccount";

/**
 * The resident page. Signing in is what makes it yours: the dashboard is scoped
 * to the signed-in student's own paid bookings, so the page asks who you are
 * before it asks the server for anything.
 */
export default function HostelResidentPage() {
  const { ready, account } = useStudentAccount();
  return <CampusShell
    area="HOSTELFINDER RESIDENT"
    title="Where you live this year"
    subtitle="Your bed, your host's number, the services you asked for and the thread between you."
  >
    <section className="student-auth-interface">
      {!ready
        ? <p className="hostel-resident-loading">Checking your account…</p>
        : account
          ? <ResidentDashboard />
          : <>
            <CampusStatusBanner
              title="Sign in to open your residency"
              message="Your residency is tied to the @st.umat.edu.gh account that paid for the bed, so nobody else can read your room or your messages."
            />
            <StudentAuthCard next="/hostel/resident" />
          </>}
    </section>
  </CampusShell>;
}
