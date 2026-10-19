import type { Metadata } from "next";
import { CampusShell } from "@/components/campusRide/shared/CampusShell";
import { CinemaEventDetail } from "@/components/cinema/CinemaEventDetail";
import { readPublicCinemaEvent } from "@/lib/cinema-engine/events";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  try {
    const { id } = await params; const event = await readPublicCinemaEvent(id);
    const description = event.description || `${event.organizer.name} invites you to ${event.title} on UMaTeXPRESS Cinema.`;
    return { title: `${event.title} | UMaTeXPRESS Cinema`, description, openGraph: { title: event.title, description, type: "website", ...(event.posterUrl ? { images: [event.posterUrl] } : {}) } };
  } catch { return { title: "Cinema event | UMaTeXPRESS", description: "Open a UMaTeXPRESS Cinema event invitation, RSVP, and join the session." }; }
}
export default async function CinemaEventPage({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return <CampusShell area="CINEMA" title="Cinema event" subtitle="A scheduled organizer programme with an RSVP, attendance limit and live event room."><CinemaEventDetail id={id} /></CampusShell>; }
