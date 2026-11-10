import type { Metadata } from "next";
import { CampusShell } from "@/components/campusRide/shared/CampusShell";
import { CinemaRoomPlansPage } from "@/components/cinema/CinemaRoomPlansPage";
import { CinemaSectionNav } from "@/components/cinema/CinemaSectionNav";

export const metadata: Metadata = { title: "Cinema room plans | UMaTeXPRESS", description: "Compare Cinema watch-room upload plans and manage your room hosting access." };
export default function RoomPlansPage() { return <CampusShell area="CINEMA" title="Room plans" subtitle="Compare file limits and choose your watch-room allowance."><CinemaSectionNav current="plans" /><CinemaRoomPlansPage /></CampusShell>; }
