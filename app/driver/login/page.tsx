import Link from "next/link";
import { DriverLoginForm } from "@/components/campusRide/driver/DriverLoginForm";
import { CampusShell, CampusStatusBanner } from "@/components/campusRide/shared/CampusShell";

export default function DriverLoginPage() {
  return <CampusShell area="DRIVER PORTAL" title="Driver sign in" subtitle="Driver authentication will connect assigned vehicles to live campusRide queues.">
    <section className="driver-login-interface">
      <CampusStatusBanner title="Driver access" message="Sign in with the phone or email assigned to your driver profile." />
      <DriverLoginForm />
      <Link href="/campus">Return to campusRide</Link>
    </section>
  </CampusShell>;
}
