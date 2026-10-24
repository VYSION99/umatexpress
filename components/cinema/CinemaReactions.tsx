"use client";

import type { CSSProperties } from "react";
import { CINEMA_REACTIONS, type CinemaReaction } from "@/lib/cinema-engine/protocol";
import type { CinemaReactionEvent } from "./useCinemaSocket";

const REACTION_LABELS: Record<CinemaReaction, string> = {
  "👏": "Applause", "❤️": "Love", "😂": "Laugh", "😮": "Surprised",
  "🔥": "Fire", "🙌": "Celebrate", "👍": "Like", "🎉": "Party",
  "💡": "Idea", "🤔": "Thinking", "💯": "Agree", "✅": "Understood",
};

export function CinemaReactionOverlay({ reactions, placement = "overlay" }: { reactions: CinemaReactionEvent[]; placement?: "overlay" | "rail" }) {
  if (!reactions.length && placement === "overlay") return null;
  return <div className={`cinema-stream-reactions${placement === "rail" ? " is-rail" : ""}`} aria-label="Live reactions">
    {placement === "rail" && <small className="cinema-reactions-label">Live reactions</small>}
    {reactions.slice(-6).map((reaction, index) => <span
      key={reaction.id}
      className="cinema-stream-reaction"
      style={{ "--reaction-lane": index % 3 } as CSSProperties}
      title={`${reaction.name}: ${REACTION_LABELS[reaction.emoji]}`}
    >{reaction.emoji}</span>)}
  </div>;
}

export function CinemaReactionPicker({ onReact, onClose }: { onReact: (emoji: CinemaReaction) => void; onClose: () => void }) {
  return <div className="cinema-reaction-picker" role="group" aria-label="Send a reaction">
    {CINEMA_REACTIONS.map((emoji) => <button key={emoji} type="button" title={REACTION_LABELS[emoji]} aria-label={`React: ${REACTION_LABELS[emoji]}`} onClick={() => onReact(emoji)}>{emoji}</button>)}
    <button type="button" className="cinema-reaction-close" aria-label="Close reactions" onClick={onClose}>×</button>
  </div>;
}
