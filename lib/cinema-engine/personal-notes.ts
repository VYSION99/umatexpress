/** Browser-local notes; these helpers never perform a network request. */
export const CINEMA_NOTES_MAX = 20_000;
export const CINEMA_NOTES_CHANGED = "cinema-personal-notes-changed";
export const CINEMA_NOTES_BEFORE_APPEND = "cinema-personal-notes-before-append";
export const cinemaNotesKey = (roomId: string, accountId = "device") => `umatexpress.cinema.notes.v2:${encodeURIComponent(accountId)}:${encodeURIComponent(roomId)}`;
export const cinemaLegacyNotesKey = (roomId: string) => `umatexpress.cinema.notes.v1:${roomId}`;
type NoteStorage = Pick<Storage, "getItem" | "setItem">;
export function readCinemaPersonalNotes(storage: NoteStorage, roomId: string, accountId?: string) {
  return (storage.getItem(cinemaNotesKey(roomId, accountId)) || "").slice(0, CINEMA_NOTES_MAX);
}
export function writeCinemaPersonalNotes(storage: NoteStorage, roomId: string, accountId: string | undefined, text: string) {
  if (text.length > CINEMA_NOTES_MAX) throw new Error("Your notes are full. Shorten them before adding more.");
  const key = cinemaNotesKey(roomId, accountId); storage.setItem(key, text);
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(CINEMA_NOTES_CHANGED, { detail: { key, text } }));
  return text;
}
export function appendCinemaPersonalNotes(storage: NoteStorage, roomId: string, accountId: string, excerpt: string) {
  if (typeof window !== "undefined") {
    const detail = { key: cinemaNotesKey(roomId, accountId), blocked: false };
    window.dispatchEvent(new CustomEvent(CINEMA_NOTES_BEFORE_APPEND, { detail }));
    if (detail.blocked) throw new Error("Your current notes have unsaved changes. Copy or save them before adding an explanation.");
  }
  const previous = readCinemaPersonalNotes(storage, roomId, accountId);
  return writeCinemaPersonalNotes(storage, roomId, accountId, `${previous}${previous ? "\n\n" : ""}${excerpt}`);
}
