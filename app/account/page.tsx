import Link from "next/link";
import { CampusShell, CampusStatusBanner } from "@/components/campusRide/shared/CampusShell";
import { StudentAuthCard } from "@/components/account/StudentAuthCard";

/**
 * The platform sign-in. campusRide and vacationRide both send passengers here,
 * so an account is never created per service.
 */
export default async function AccountPage({ searchParams }: { searchParams?: Promise<{ next?: string }> }) {
  const params = await searchParams;
  return <CampusShell area="UMATEXPRESS ACCOUNT" title="Sign in to book" subtitle="One UMaT account for campusRide and vacationRide. Browsing stays open to everyone.">
    <section className="student-auth-interface">
      <CampusStatusBanner title="Only booking needs an account" message="Search rides, compare fares and check a ticket without signing in. Holding a seat or joining a queue needs your student account." />
      <StudentAuthCard next={params?.next} />
      <Link href="/">Back to UMaTeXPRESS home</Link>
    </section>
  </CampusShell>;
}
