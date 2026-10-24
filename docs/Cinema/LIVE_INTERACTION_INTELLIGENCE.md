# Cinema live interaction and Python assistance

Cinema keeps authorization and moderation decisions in the TypeScript app. A
stored question or poll change sends a small hint through the room Durable
Object. Connected panels refetch their own authorized view; the socket never
broadcasts pending question text or personal votes. Pending questions notify
hosts and co-hosts only. Approvals and poll opening/closing notify connected
members. Votes continue to use the existing periodic tally refresh so a large
vote does not cause one database read per viewer for every ballot.

The broadcast-audience page opens an update-only socket. The Worker first
checks verified membership and viewer role. The Durable Object excludes these
sockets from speaking-stage presence, chat replay and playback broadcasts;
they receive interaction hints and room closure only. Periodic panel refresh
remains as a recovery path after missed messages. This needs a deployed
100-viewer load test before the audience limit is marketed as proven.
Audience sockets still count as connected viewers for idle-room cleanup, so a
discussion cannot expire while its broadcast audience is watching.

Hosts and co-hosts may request **Find similar questions**. The TypeScript route
checks their room role, limits requests, and sends only current pending and
approved question IDs and text to the private Python Intelligence Worker. A
deterministic word-overlap algorithm suggests groups of close wording. It does
not approve, dismiss, combine, or reorder any question. The app validates the
returned IDs against the current authorized queue. If Python is unavailable,
the queue still works and the button reports that suggestions are unavailable.

Study-pack requests now record a `QUEUED` job. The existing bounded Cinema
maintenance pass claims at most one job per run, builds the pack, and records
`DONE` or `FAILED`; a stale `RUNNING` claim can be reclaimed after ten minutes.
The page shows job progress and allows a failed job to be retried. A consented
transcript or bookmark is still required, and only hosts or co-hosts may ask
for generation. This uses the existing AI provider path and does not upload
video to Python. At one job per five-minute pass, a busy queue may take longer
than five minutes.

Next slices: consented transcript quality improvements and timestamp-grounded
“Explain this moment” answers.
