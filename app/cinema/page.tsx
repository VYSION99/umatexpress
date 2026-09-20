import type { Metadata } from "next";
import { CampusShell } from "@/components/campusRide/shared/CampusShell";
import { CinemaLobby } from "@/components/cinema/CinemaLobby";

export const metadata: Metadata = {
  title: "Cinema | UMaTeXPRESS",
  description: "A shared room for UMaT students: one YouTube video, one link, one conversation — study together or unwind together.",
};

/**
 * The Cinema lobby. The account check lives in the client component because the
 * page itself has nothing account-specific to render: a signed-out visitor sees
 * the same shell with a sign-in card in the middle of it.
 */
export default function CinemaPage() {
  return <CampusShell
    area="CINEMA"
    title="Watch together"
    subtitle="One link, one video, one conversation — for a revision session or a break between lectures."
  >
    <CinemaLobby />
  </CampusShell>;
}
