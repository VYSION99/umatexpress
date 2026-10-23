# Reusable Cinema watch rooms

Watch rooms now keep a stable invitation link. The link identifies a saved room setup; each **Start again** action creates a new temporary Cinema session behind it. Event sessions are never saved as watch rooms. New watch rooms are saved automatically. A host can also start an older ended watch room again before its old link is purged.

The saved setup keeps its title, source type, public/private setting, YouTube video ID when applicable, preferred duration, and invited verified-account IDs. Only the host can start it again. A private file room remains private; it starts with an empty playlist, and the host must upload new files. The new session gets a fresh host seat, a fresh upload-plan allowance, chat, attendance, polls, notes and playback state. Previous session records and temporary media keep their existing retention deadline. A downgraded upload plan caps the new session's duration to the current allowance.

The lobby shows saved rooms separately from recent session history. When a saved room is between sessions, its stable link shows a waiting page to guests and a **Start again** action to the host. The host may remove the saved setup and its persistent guest list after ending the current session. Existing session records still follow normal retention.

Apply `sql/044_cinema_reusable_rooms.sql` to an existing database, or allow the runtime schema pass to create it. Verify a private room by inviting a second verified account, ending the session, starting again from the original URL, and confirming the guest can enter the new session but old chat and uploaded files are absent. Also confirm an event cannot be reused through this API and that a second simultaneous restart is rejected.
