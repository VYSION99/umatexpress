# Cinema pricing and department/club adoption proposal

**Status:** proposal for customer interviews, not an active checkout or promise of LiveKit service.
**Date:** 14 October 2026. Review supplier prices, exchange rates, and costs monthly.
**Scope:** Cinema events and a proposed managed LiveKit stage. This document does not change hostel, ride, or other service prices.

## The product to sell

Departments and clubs can already run a video meeting elsewhere. Google Meet offers up to 100 people for 60 minutes at no cost, and eligible schools can use Teams for Education without paying for a separate meeting product. Cinema must therefore sell the *campus event workflow*, not a claim that its call is cheaper: discoverable event pages and posters, verified RSVPs and a waitlist, host-controlled questions/polls/speaking requests, attendance evidence, appropriate certificates, and a replay destination. Some of this exists now; managed LiveKit media and automatic stage-to-broadcast output do **not** exist yet. The current discussion host supplies a separate YouTube broadcast, and its link can be watched outside Cinema.

The strongest buyers are a department running recurring tutorials, seminars or outreach and a club running debates or panels. Their practical outcome is less event administration and a repeatable record of participation. Prove that with a pilot and organizer feedback; do not assume a department will buy solely because the feature list is longer.

## Proposed public offer

Prices are **GH₵ paid by the organizer**, inclusive of the modeled 1.95% payment processing fee. Audience members are not charged in this proposal. “Audience up to 100” means verified **in-app participation**, not private or capped YouTube playback. Managed-stage recording, live captions, AI-generated notes, custom certificates, operator-run production, and private paid broadcast access are excluded from these packages until their integrations and costs are validated; some related features already exist in self-service Cinema rooms.

| Offer | Price | Entitlement and buyer |
| --- | ---: | --- |
| Community | Free | Existing self-service study room or screening/tutorial using the current media path. No managed LiveKit stage or automatic broadcast. Good entry point for student groups. |
| Club | GH₵900/month prepaid | Two scheduled discussion events, up to two hours each, six stage places and up to 100 in-app audience RSVPs per event. The club operates its own event; shared managed LiveKit capacity is included **only after launch**. |
| Department | GH₵4,500/month prepaid | Ten scheduled discussion events, up to two hours each, on the same media limits. One onboarding session and an agreed primary organizer contact. A department can allocate events to approved student groups. |
| One-off managed event | GH₵800 prepaid | One two-hour discussion event; sell only when the media service has already passed the monthly activation gate below. |
| Extra event | GH₵450 | One additional two-hour event on an active Club or Department plan; subject to available capacity. |
| Extra hour | GH₵250 | Pre-agreed extension, up to the platform's four-hour room maximum. Do not extend automatically. |

One purchased event is a reservation of the production slot. A reasonable cancellation policy should permit one date change with notice, while reserving a slot that has already begun counts as used. Do not publish cancellation/refund terms before the payment and booking workflow supports them. No organizer may book overlapping stages beyond measured capacity.

## Cost test and activation gate

The planning baseline is two 4-vCPU/8-GB DigitalOcean CPU-Optimized VMs: one LiveKit, one Egress, each listed at US$84/month. This is a conservative always-on assumption; event-time Egress may eventually cost less, but it must be measured. At the Bank of Ghana **13 October 2026 interbank mid-rate of GH₵11.7059/US$1**, US$168 is GH₵1,966.59. Applying a **15% exchange/procurement buffer** makes a GH₵2,261.58 monthly infrastructure reserve. The interbank quote is not necessarily the rate at which the company can buy US dollars.

Add a **provisional GH₵100 per managed event** for support, monitoring, messages, and other platform usage. This is an internal budgeting assumption, not a measured cost. Review it after every pilot. For ten events, the modeled monthly cost is GH₵3,261.58. A GH₵4,500 package settles approximately GH₵4,412.25 after a 1.95% Paystack fee, leaving GH₵1,150.67 (25.6% of the sticker price) before tax, refunds, exceptional support, and other unmeasured costs. Five Club packages bring in the same amount and fund the same ten event slots. Five one-off events at GH₵800 bring in GH₵3,922 after processing; subtracting infrastructure reserve and five GH₵100 event allowances leaves GH₵1,160.42. These examples are **contribution estimates, not guaranteed profit**.

Do not maintain both production VMs on an ongoing basis until **one prepaid Department package, five prepaid Club packages, or five prepaid one-off events** have been secured for the billing month. Otherwise use the existing free workflow or an explicitly time-bounded pilot. Recheck the gate whenever prices or FX move. If actual costs exceed the assumptions, raise the next month's price or reduce included hours before accepting more bookings. Never rely on hoped-for RSVPs, advertisements, or a shareable YouTube link to fund a month.

The operating ledger needs, per event: start/end times, LiveKit and Egress VM hours, outgoing bandwidth, R2/replay storage, AI calls, notification counts, support minutes, refunds, processor fees, organizer revenue, and attributable cost. Alert before the monthly bandwidth pool is exhausted. Do not sell 100 direct LiveKit viewers on this VM sizing: the audience design sends only the small speaking stage through LiveKit and distributes playback separately.

## Control build and infrastructure cost

Keep the current self-service Cinema and external-broadcast path while validating buyers. Pilot the proposed LiveKit stage behind a feature flag with one event format; do not build a second chat, RSVP, poll, recording, or AI system. The existing Worker and Durable Object remain the authority for identity, access and participation. LiveKit carries stage media only. This narrows the migration and keeps a working fallback during testing.

For an early proof of concept, managed LiveKit Cloud avoids server operations; compare its *actual* connection-minute, bandwidth and transcoding bill with the self-hosted pilot before selecting production hosting. Its free Build allowance is capped (including 5,000 WebRTC participant-minutes, 50 GB downstream and 60 transcode minutes at the source check), so a two-hour automated broadcast is not a free-tier assumption. This is a development-cost comparison, not a commitment to Cloud pricing.

For self-hosted production, keep the LiveKit VM stable and evaluate event-time Egress: provision before soundcheck, verify readiness, run the broadcast, wait for its completion/exports, then destroy that VM. Powering a Droplet off does not stop billing. At US$0.125/hour, ten four-hour Egress windows would be roughly US$5 of *Egress compute* instead of its US$84 full-month cap; this excludes transfer, storage, snapshots, retries and operational work. Never depend on just-in-time provisioning until repeated rehearsals show it starts reliably. Short-lived Droplets accrue their transfer allowance only while they exist.

Set a monthly infrastructure budget and alert threshold, an event-hour cap, a stage-member cap, a hard AI-call limit and a release gate before any new paid feature. Add recording/captions/AI notes only when an organizer requests and funds them; keep them opt-in and governed by Cinema's session privacy settings. Recalculate package prices after the pilot rather than assuming the lower Egress bill is guaranteed.

## Why an organizer would choose Cinema

| Alternative | What it already does well | Cinema's proposed reason to pay |
| --- | --- | --- |
| Free Meet or Teams | Familiar meetings with no new vendor charge for eligible users. | A public campus event catalogue, organizer identity, RSVP/waitlist, moderated debate format, and event-linked attendance/certificates. Do not pretend basic video is the differentiator. |
| YouTube Live alone | Established mass playback and replay. | A controlled in-app speaking queue, verified participation, audience questions/polls, and a campus-facing event record. Playback remains shareable until protected delivery is built. |
| General event/meeting software | Mature video and admin tools. | UMaT-specific discovery and a local event workflow tied to the existing student accounts. Validate that organizers value this enough to pay. |

To reduce switching friction, keep free self-service events as the acquisition path. Offer a paid pilot of two or three recurring events to a department, with a named organizer, setup help, and a post-event review of RSVPs, attendance, questions, and feedback. Ask what work their current tools left for them to do manually, then demonstrate that Cinema removes that work. Make the same pilot available to a club through departmental sponsorship rather than forcing students to fund a full VM. Credit pilot payments toward the first monthly package if the organizer continues, but do not run indefinite free managed stages.

Two product gaps matter before collecting package payments: (1) automatic LiveKit stage-to-YouTube Egress and operational monitoring are not built; (2) organizer approval now gates public club and department claims, but delegated administrators, invoicing or a supported payment path, and booking entitlements are still missing. The system must refuse a managed slot when the plan is inactive or its event allowance is exhausted. Keep the free event path clearly separate.

## Rollout decision

1. Interview at least three departments and five clubs using a one-page demo and this price sheet. Capture their current tools, event volume, admin pain, and real budget authority. A positive reaction is not a purchase commitment.
2. Pilot LiveKit with one six-person stage and externally watched broadcast. Measure campus mobile-network quality and the full event cost. Then pilot automated Egress and re-run the cost calculation.
3. Obtain the activation commitments before offering the managed plan publicly. Invoice and collect in GH₵; check the actual merchant FX rate and supplier bill before each monthly renewal.
4. Launch with explicit service limits and a named support path. Review conversion, repeat booking, cost per event, and gross contribution monthly. Retire or reprice a tier that cannot meet its floor.

## Sources checked 14 October 2026

- [DigitalOcean Droplet prices](https://www.digitalocean.com/pricing/droplets) and [bandwidth billing](https://docs.digitalocean.com/platform/billing/bandwidth/)
- [Bank of Ghana daily interbank FX rates](https://www.bog.gov.gh/treasury-and-the-markets/daily-interbank-fx-rates/)
- [Paystack Ghana pricing](https://paystack.com/gh/pricing)
- [Google Meet free meeting limits](https://workspace.google.com/products/meet/) and [Microsoft Teams for Education](https://www.microsoft.com/en-us/education/products/teams)
- [LiveKit self-hosted Egress requirements](https://docs.livekit.io/transport/self-hosting/egress/)
- [LiveKit Cloud metered resources and free-tier limits](https://docs.livekit.io/deploy/admin/quotas-and-limits/)
- [DigitalOcean Droplet billing rules](https://docs.digitalocean.com/products/droplets/details/pricing/)
