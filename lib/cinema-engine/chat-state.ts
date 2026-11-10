import type { CinemaChatMessage } from "./protocol";

export function mergeCinemaChat(current: CinemaChatMessage[], incoming: CinemaChatMessage[], removed: ReadonlySet<string> = new Set()) {
  const map = new Map(current.map(message => [message.id, message]));
  for (const message of incoming) {
    const previous = map.get(message.id);
    map.set(message.id, previous?.removed ? previous : message);
  }
  return [...map.values()].map(message => message.removed || removed.has(message.id) ? { ...message, removed: true, content: "", senderName: "", atSeconds: null, video: undefined } : message)
    .sort((a, b) => (a.sequence || 0) - (b.sequence || 0) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
