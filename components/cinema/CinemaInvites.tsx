"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Mail, UserMinus, UserPlus } from "lucide-react";
import type { CinemaRoomInvite } from "@/lib/cinema-engine/rooms";

export type CinemaGuest = { studentId: string; displayName: string };

type GuestRow = CinemaRoomInvite & { inRoom: boolean };

/**
 * A private room's guest list, for its host.
 *
 * The list is the invitations and the members merged: an invited student who
 * has not arrived shows as invited, one who has walked in shows as in the
 * room, and a member who was never invited — a room that was public before it
 * closed — still appears, because the host should be able to remove anyone.
 *
 * The panel is a convenience, not the gate: the engine refuses every verb to
 * anyone but the host, and it removes the invitation and the membership
 * together, then closes the guest's sockets. What the host sees here is
 * exactly the list the engine will check.
 */
export function CinemaInvites({ roomId, members, onChanged }: {
  roomId: string;
  members: CinemaGuest[];
  onChanged?: () => void;
}) {
  const [invites, setInvites] = useState<CinemaRoomInvite[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/cinema/sessions/${roomId}/invites`, { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json() as { invites?: CinemaRoomInvite[] };
      setInvites(data.invites || []);
      setRemoved([]);
    } catch { /* the list is a convenience; the next action reads it again */ }
  }, [roomId]);

  useEffect(() => { queueMicrotask(load); }, [load]);

  const rows = useMemo(() => {
    const hidden = new Set(removed);
    const inRoom = new Map(members.map((member) => [member.studentId, member.displayName]));
    const merged: GuestRow[] = invites
      .filter((invite) => !hidden.has(invite.studentId))
      .map((invite) => ({ ...invite, inRoom: inRoom.has(invite.studentId) }));
    const listed = new Set(merged.map((row) => row.studentId));
    for (const member of members) {
      if (listed.has(member.studentId) || hidden.has(member.studentId)) continue;
      merged.push({ studentId: member.studentId, email: "", name: member.displayName, createdAt: "", inRoom: true });
    }
    return merged;
  }, [invites, members, removed]);

  const send = async () => {
    setBusy("invite"); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/cinema/sessions/${roomId}/invites`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await response.json() as { invites?: CinemaRoomInvite[]; error?: string };
      if (!response.ok) throw new Error(data.error || "The invitation was refused.");
      setInvites(data.invites || []);
      setRemoved([]);
      setEmail("");
      setNotice("Added. They will find this room in their cinema lobby.");
      onChanged?.();
    } catch (inviteError) {
      setError(inviteError instanceof Error ? inviteError.message : "The invitation was refused.");
    } finally {
      setBusy("");
    }
  };

  const remove = async (guestId: string) => {
    setBusy(guestId); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/cinema/sessions/${roomId}/guests?studentId=${encodeURIComponent(guestId)}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      const data = await response.json() as { removed?: boolean; invites?: CinemaRoomInvite[]; error?: string };
      if (!response.ok) throw new Error(data.error || "That guest could not be removed.");
      setInvites(data.invites || []);
      setRemoved((current) => [...current, guestId]);
      setNotice(data.removed
        ? "Removed. They can no longer read or enter this room."
        : "That student was not on the guest list.");
      onChanged?.();
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "That guest could not be removed.");
    } finally {
      setBusy("");
    }
  };

  return <div className="cinema-invites">
    <h3><Mail size={15} aria-hidden /> Guest list</h3>
    <p className="cinema-note">
      Only the students on this list can read or join this private room. Invite by their <strong>@st.umat.edu.gh</strong> address;
      removing someone takes back the invitation and the seat, and closes the room on their screen.
    </p>
    <form className="cinema-invite-form" onSubmit={(event) => { event.preventDefault(); void send(); }}>
      <input
        type="email"
        value={email}
        required
        placeholder="student@st.umat.edu.gh"
        aria-label="The student's UMaT email address"
        onChange={(event) => setEmail(event.target.value)}
      />
      <button type="submit" disabled={busy === "invite" || !email.trim()}><UserPlus size={15} aria-hidden /> Invite</button>
    </form>
    {error && <p className="cinema-error">{error}</p>}
    {notice && <p className="cinema-report-notice" role="status">{notice}</p>}
    {rows.length === 0
      ? <p className="cinema-note cinema-sub">Nobody is on the list yet: with the room private, nobody else can walk in.</p>
      : <ul className="cinema-invite-list">
        {rows.map((row) => <li key={row.studentId}>
          <div>
            <strong>{row.name || row.email || "A student"}</strong>
            {row.email && <small>{row.email}</small>}
          </div>
          <span className={`cinema-guest-tag${row.inRoom ? " is-in" : ""}`}>{row.inRoom ? "In the room" : "Invited"}</span>
          <button
            type="button"
            className="secondary"
            disabled={Boolean(busy)}
            aria-label={`Remove ${row.name || row.email || row.studentId} from this room`}
            onClick={() => void remove(row.studentId)}
          ><UserMinus size={14} aria-hidden /></button>
        </li>)}
      </ul>}
  </div>;
}
