# Cinema file room playlists

File rooms default to invite-only. The host may explicitly make one public (any verified account with the link may join). Public does not mean an anonymous video URL or a catalogue listing: the viewer must sign in, join the room, and receive a playback lease. The host confirms they have the right to share each uploaded file with everyone eligible to join. Switching visibility does not move existing members or change the private R2 storage.

File rooms hold an ordered queue. The host uploads files one at a time from the room or lobby and can reorder files that have not started. The active file stays selected while later files upload. When a host or co-host's player reaches the end, it advances after a short pause; they can also use **Next file / discussion**. If no host or co-host has the player open, playback waits for one to return and advance it. The final file leaves the room open for discussion. The host's **End room** action and the existing idle cleanup still close the room. Scheduled room deadlines remain a safety limit.

| Plan | Files | Total stored bytes | Total known playback time |
| --- | ---: | ---: | ---: |
| Free | 1 | 500 MB | 60 minutes |
| Student Plus | 3 | 2 GB | 3 hours |
| Student Politics Plus | 6 | 3 GB | 4 hours |
| Club / Department Pro | 10 | 5 GB | 5 hours |
| Pro Plus | 15 | 8 GB | 5 hours |

An allowance is copied to each room when it is created. Changing a host's plan affects new rooms only. File count and byte limits are enforced by the API; the duration check uses media metadata when the server can read it. Some MOV files and WebM files do not expose duration in the object head, so the room's scheduled deadline and idle cleanup remain important safeguards. The deployment-wide per-file upload limit also applies.

Verified UMaT student accounts can compare plans at `/cinema/rooms/plans`. The default base prices for 30 days are GH₵37 for Student Plus, GH₵59 for Student Politics Plus, GH₵86 for Club / Department Pro, and GH₵119 for Pro Plus, before the displayed processing fee. Club / Department Pro and Pro Plus require an approved club or department organizer profile. For Student Politics Plus, a Cinema admin verifies the student's organizer role and approves checkout from the plan console. The admin can set an expiry or revoke approval for future checkout. Managed events remain a separate offer.

The plan finder uses playlist size, video count and total duration to compare plans. It recognizes a current plan that fits and otherwise recommends the cheapest eligible option using the published checkout totals. It flags approval requirements and reminds buyers to check individual file limits. Paid plans are prepaid and do not renew automatically. Admins can change prices and checkout availability. Existing orders keep their original quote.

The server activates access after a successful GHS payment for the exact quote, verified by the callback check or a signed Paystack webhook. **Check payment** can recover an existing checkout link from the payment journal. A linkless checkout can close after five minutes if Paystack explicitly reports the reference missing. A payment reported after closure goes to finance review. Processed refunds are counted once by refund ID. Partial refunds go to review, and a total refund revokes the associated grant. A 30-day grant expires automatically, and a reusable room's next session uses the plan active at that time. Existing rooms retain their allowance for the current session.

Databases managed by SQL migrations use `sql/048_cinema_room_plan_checkout.sql`, `sql/057_cinema_room_plan_prices.sql`, `sql/058_cinema_room_plan_tiers.sql`, and `sql/059_cinema_room_plan_refunds.sql`. Runtime setup creates the same tables and prices. Before releasing paid checkout, configure the existing Paystack secret, signed webhook, and `PAYSTACK_CURRENCY=GHS`, then verify one sandbox payment, callback, webhook retry, and full refund end to end. Local tests cover database settlement rules. Provider and mobile payment return still need sandbox acceptance.

If a transfer pauses, keep the tab open. **Resume upload** keeps the parts already received and retries the first missing part after any indicated wait. After a page reload, the host can cancel the unfinished transfer and start over.

Apply `sql/043_cinema_room_playlists.sql` to an existing database, or let the runtime schema pass migrate it. Existing single-file uploads become position one. The private R2 bucket and signed media leases remain in place. Each media request also checks that the signed-in account matches the lease owner. Only the active file gets a playback lease; moving to the next file invalidates the previous file's lease on its next range request. Cleanup now deletes every file in the room.

For acceptance, create a Free room and confirm a second file is refused; assign Student Plus to a test account and confirm three files play in order, a fourth is refused, and the room stays live after the third. Test both public and invite-only file rooms: a verified account with a public link can join, an uninvited account cannot join a private room, and completing an upload does not change visibility. Confirm an ended room and a removed guest cannot obtain a media lease, and a lease cannot be used from another account. Check MP4, MOV and WebM in browsers used by students, especially iOS, before treating duration limits as comprehensive.
