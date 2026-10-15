import type { Metadata } from "next";
import { CampusShell } from "@/components/campusRide/shared/CampusShell";
import { CinemaEvents } from "@/components/cinema/CinemaEvents";

export const metadata: Metadata = { title: "Cinema events | UMaTeXPRESS", description: "Discover live tutorials, screenings, talks and student community events at UMaT." };
export default function CinemaEventsPage() { return <CampusShell area="CINEMA" title="Cinema events" subtitle="Discover what UMaT is watching, teaching and discussing."><CinemaEvents /></CampusShell>; }
