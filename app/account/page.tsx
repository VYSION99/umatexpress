import Link from "next/link";
import { ArrowLeft } from "@/components/ui/MaterialIcon";
import { CampusShell } from "@/components/campusRide/shared/CampusShell";
import { StudentAuthCard } from "@/components/account/StudentAuthCard";
import { PassengerSupportCard } from "@/components/account/PassengerSupportCard";
import { safeAuthReturnPath } from "@/lib/auth-return";

/** One account entry point for UMaTeXPRESS services. */
export default async function AccountPage({ searchParams }: { searchParams?: Promise<{ next?: string }> }) {
  const params = await searchParams;
  const destination = safeAuthReturnPath(params?.next);
  const cinemaAudience = destination.startsWith("/cinema");
  const profileAccess = destination.startsWith("/profile");
  const campusRide = destination.startsWith("/campus?") && new URL(destination, "https://umatexpress.local").searchParams.has("rideId");
  const printCopy = destination === "/print-copy" || destination.startsWith("/print-copy?");
  const printCopyQuote = printCopy && new URL(destination, "https://umatexpress.local").searchParams.has("quoteProviderId");
  return <CampusShell area="UMATEXPRESS ACCOUNT" title={cinemaAudience ? "Join Cinema events" : profileAccess ? "Your account" : campusRide ? "Sign in to join the queue" : printCopyQuote ? "Sign in to request a quote" : printCopy ? "Sign in for Print & Copy" : "Your UMaTeXPRESS account"} subtitle={cinemaAudience ? "A verified account lets you reserve a place and join public discussions." : profileAccess ? "Sign in or verify your email to manage your profile and security." : campusRide ? "We'll take you back to your selected ride afterward." : printCopyQuote ? "We'll take you back to this print shop afterward." : printCopy ? "We'll take you back to Print & Copy afterward." : "Sign in to access the services available to your account."}>
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
      </aside> : null}
      {!cinemaAudience && !profileAccess && <Link className="student-auth-back" href={campusRide ? destination : printCopy ? "/print-copy" : "/"}><ArrowLeft size={18} aria-hidden />{campusRide ? "Back to selected ride" : printCopy ? "Back to Print & Copy" : "Back to home"}</Link>}
      <StudentAuthCard next={params?.next} />
      {!cinemaAudience && !profileAccess && <PassengerSupportCard />}
    </section>
  </CampusShell>;
}
