"use client";
import { useState } from "react";
export type CinemaPreparedShare = { id: string; accountId: string; text: string; origin: "NOTE" | "EXPLANATION" };
/** Preparing an excerpt never sends it; the room composer remains the send boundary. */
export function CinemaShareReview({ share, blocked, onPrepare, onDismiss }: { share: CinemaPreparedShare; blocked: boolean; onPrepare: (text: string) => void; onDismiss: () => void }) {
  const [text, setText] = useState(share.text);
  return <section className="cinema-share-review" aria-label="Review sharing into room chat">
    <h3>Review selected {share.origin === "NOTE" ? "note" : "AI explanation"}</h3>
    <p className="cinema-note">Everyone in the room can read the excerpt after you send it. Edit it here, then use the normal chat composer to send.</p>
    <textarea aria-label="Excerpt to share with the room" value={text} rows={4} onChange={event => setText(event.target.value)} />
    <p className="cinema-note">{text.length}/500 characters{blocked ? " · Send or clear your existing room draft first." : ""}</p>
    <div className="cinema-private-actions"><button type="button" disabled={blocked || !text.trim() || text.length > 500} onClick={() => onPrepare(text.trim())}>Use excerpt in composer</button><button type="button" onClick={onDismiss}>Keep it private</button></div>
  </section>;
}
