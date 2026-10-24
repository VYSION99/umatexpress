# Cinema file room playlists

File rooms default to invite-only. The host may explicitly make one public (any verified account with the link may join). Public does not mean an anonymous video URL or a catalogue listing: the viewer must sign in, join the room, and receive a playback lease. The host confirms they have the right to share each uploaded file with everyone eligible to join. Switching visibility does not move existing members or change the private R2 storage.

File rooms hold an ordered queue. The host uploads files one at a time from the room or lobby and can reorder files that have not started. The active file stays selected while later files upload. When a host or co-host's player reaches the end, it advances after a short pause; they can also use **Next file / discussion**. If no host or co-host has the player open, playback waits for one to return and advance it. The final file leaves the room open for discussion. The host's **End room** action and the existing idle cleanup still close the room. Scheduled room deadlines remain a safety limit.

| Plan | Files | Total stored bytes | Total known playback time |
| --- | ---: | ---: | ---: |
| Free | 1 | 500 MB | 60 minutes |
| Student Plus | 3 | 2 GB | 3 hours |
| Club / Department Pro | 5 | 5 GB | 5 hours |

An allowance is copied to each room when it is created. Changing a host's plan affects new rooms only. File count and byte limits are enforced by the API; the duration check uses media metadata when the server can read it. Some MOV files and WebM files do not expose duration in the object head, so the room's scheduled deadline and idle cleanup remain important safeguards. The deployment-wide per-file upload limit also applies.

Paid-tier assignment is currently an **admin grant**, visible on the Cinema console. An admin should record a payment reference or institutional authorization before assigning it. This change does not introduce a self-service subscription checkout or assert that a plan has been paid. Those need agreed prices, payment webhook reconciliation, expiry/renewal rules, and refund handling before release.

Apply `sql/043_cinema_room_playlists.sql` to an existing database, or let the runtime schema pass migrate it. Existing single-file uploads become position one. The private R2 bucket and signed media leases remain in place. Each media request also checks that the signed-in account matches the lease owner. Only the active file gets a playback lease; moving to the next file invalidates the previous file's lease on its next range request. Cleanup now deletes every file in the room.

For acceptance, create a Free room and confirm a second file is refused; assign Student Plus to a test account and confirm three files play in order, a fourth is refused, and the room stays live after the third. Test both public and invite-only file rooms: a verified account with a public link can join, an uninvited account cannot join a private room, and completing an upload does not change visibility. Confirm an ended room and a removed guest cannot obtain a media lease, and a lease cannot be used from another account. Check MP4, MOV and WebM in browsers used by students, especially iOS, before treating duration limits as comprehensive.
