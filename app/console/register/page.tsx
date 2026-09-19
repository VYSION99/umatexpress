import Link from "next/link";
import { BedDouble, BusFront, Clapperboard, Store, UserRoundCheck, Utensils } from "lucide-react";
import { consoleApplications, consoleInvitedAccess } from "@/lib/console-applications";
import { consoleServiceById } from "@/components/admin/console-services";

const APPLICATION_ICONS = {
  organizer: Store,
  landlord: BedDouble,
  vendor: Utensils,
  cinema: Clapperboard,
} as const;

/**
 * The door into the console. One page for every service, because the console is
 * one account for every service: what changes between them is the application
 * the person fills in, not the place they start.
 *
 * Operational roles are named here but never applied for. A public form that
 * could mint a driver or a moderator would be a way to promote yourself, so
 * those roles are set up by the team that runs them.
 */
export default function ConsoleAccessPage() {
  return <main className="console-auth-page console-apply-page">
    <div className="console-apply-shell">
      <header className="console-apply-head">
        <img src="/logo.svg" alt="UMaTeXPRESS" />
        <p>UMATEXPRESS CONSOLE</p>
        <h1>Get access</h1>
        <span>One account for every UMaTeXPRESS service. Apply for the service you want to run, or sign in if the team already set you up.</span>
      </header>

      <section className="console-apply-grid" aria-label="Applications">
        {consoleApplications.map((application) => {
          const Icon = APPLICATION_ICONS[application.id as keyof typeof APPLICATION_ICONS] || BusFront;
          const service = consoleServiceById(application.reviewService);
          return <article className="console-card" key={application.id}>
            <span className="console-card-icon"><Icon size={21} /></span>
            <p className="console-card-label">{application.status === "OPEN" ? "OPEN FOR APPLICATIONS" : "COMING SOON"}</p>
            <h2>{application.short}</h2>
            <p className="console-card-detail">{application.blurb}</p>
            {application.status === "OPEN"
              ? <Link className="console-card-action" href={`/console/register/${application.id}`}>{application.applyLabel}</Link>
              : <span className="console-card-soon">Opens with {service?.title || application.reviewService}</span>}
          </article>;
        })}
      </section>

      <section className="console-apply-invited" aria-label="Set up by the team">
        <h2>Set up by the team</h2>
        <p>These roles are never self-service: someone already responsible for the work adds you.</p>
        {consoleInvitedAccess.map((entry) => <article key={entry.id}>
          <span className="console-card-icon"><UserRoundCheck size={19} /></span>
          <div>
            <strong>{entry.title}</strong>
            <span>{entry.detail}</span>
            <small>{entry.contact}</small>
          </div>
        </article>)}
      </section>

      <div className="console-apply-foot">
        <Link href="/console/login">Already have access? Sign in</Link>
      </div>
    </div>
  </main>;
}
