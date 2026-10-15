import Link from "next/link";
import { CampusShell, CampusStatusBanner } from "@/components/campusRide/shared/CampusShell";
import { StudentAuthCard } from "@/components/account/StudentAuthCard";
import { PassengerSupportCard } from "@/components/account/PassengerSupportCard";

/**
 * The platform sign-in. campusRide and vacationRide both send passengers here,
 * so an account is never created per service.
 */
export default async function AccountPage({ searchParams }: { searchParams?: Promise<{ next?: string }> }) {
  const params = await searchParams;
  const cinemaAudience = params?.next?.startsWith("/cinema") === true;
  return <CampusShell area="UMATEXPRESS ACCOUNT" title={cinemaAudience ? "Join Cinema events" : "Sign in to book"} subtitle={cinemaAudience ? "A verified account lets you reserve a place and join public discussions." : "One UMaT account for campusRide and vacationRide. Browsing stays open to everyone."}>
    <section className={`student-auth-interface${cinemaAudience ? " student-auth-interface--cinema" : ""}`}>
      {cinemaAudience ? <aside className="cinema-auth-intro" aria-label="About Cinema access">
        <span className="cinema-auth-eyebrow">CINEMA ACCESS</span>
        <h2>Watch first.<br />Join when ready.</h2>
        <p>Explore live video events and panel discussions without an account. Sign in with a verified email when you want to take part.</p>
        <div className="cinema-auth-paths">
          <div><strong>For every verified account</strong><span>Reserve a place, ask a question, vote, or request the speaking stage.</span></div>
          <div><strong>For UMaT students</strong><span>Publish an event, host a panel, or create a smaller private room.</span></div>
        </div>
        <Link className="cinema-auth-browse" href="/cinema">Browse events without signing in</Link>
      </aside> : <CampusStatusBanner title="Only booking needs an account" message="Search rides, compare fares and check a ticket without signing in. Holding a seat or joining a queue needs your student account." />}
      <StudentAuthCard next={params?.next} />
      {!cinemaAudience && <PassengerSupportCard />}
      {!cinemaAudience && <Link href="/">Back to UMaTeXPRESS home</Link>}
    </section>
  </CampusShell>;
}
