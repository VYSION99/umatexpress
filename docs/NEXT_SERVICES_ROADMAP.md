# Next student services roadmap

**Planning date:** 27 September 2026 · **Last updated:** 1 November 2026
**Status:** Food M1–M4 implemented behind controlled launch gates. Print & Copy first release implemented as a verified directory with signed-in quote requests and staff review. Both public launches remain gated on verified providers and named operational owners. Food payments have independent default-off global and provider gates; delivery remains unavailable. Print & Copy file uploads and online payments are not part of its first release.

## Print & Copy first implementation (1 November 2026)

The first release provides a public directory at `/print-copy`, staff-managed listings at `/console/print-copy`, provider verification and suspension, student correction reports, and quote requests from signed-in UMaT students. Listings require reconfirmation every 30 days. The quote switch defaults off and requires a named support owner and a currently verified shop before staff can open it. Quotes capture a short job description only; document upload is intentionally absent. Students can track their own request status, and status changes queue an email notification. Authorized staff follow up using the student's account email. Expired quote records are purged daily after 90 days. Reading the staff quote queue is audit logged.

Do not advertise the service as live until real providers are verified and staff have an owner and follow-up process for quote requests. Quote requests expire after 90 days and expired records are purged during quote service activity. Confirm the shop's process for receiving files directly with the student; the platform does not store print documents.

## Food M1 implementation (19 October 2026)

The first Food milestone now provides a staff-managed provider directory, timestamped menus and prices, provider verification records, publication and suspension controls, and a student correction route. Any edit returns a published listing to draft so changed details must be checked again. The public query returns only records with both `PUBLISHED` status and a verification date.

Platform staff and Food-scoped admin delegates manage the directory at `/console/food`. Public browsing at `/food` does not require an account. Students can report stale hours, menu, price, location or contact details; staff record an outcome before closing the report. The schema is in `sql/039_food_directory.sql` and the canonical migration bundle.

The homepage Food card remains in **On the way** until staff have entered and verified real providers. Vendor self-service, “open now” claims, live item availability, ordering, delivery and payments remain outside M1.

## Food M2 implementation (19 October 2026)

M2 adds a controlled **pickup preorder pilot** without delivery or online payment. A verified UMaT student selects menu items and a pickup time inside the provider’s configured window. The request stores item names and prices as immutable snapshots, receives a reference, and remains unconfirmed until the assigned vendor accepts it. Students can view requests and cancel before the provider’s cutoff.

Food vendors can now apply for a `VENDOR` console account. Registration does not grant access to a listing or another vendor’s orders. Platform staff must link the account to exactly one published provider after confirming the relationship. The vendor’s Food-only workspace supports `REQUESTED → ACCEPTED → READY → COLLECTED`, with explicit decline and expiry paths. Status decisions notify the student; new requests notify the vendor.

Staff control the minimum lead time, maximum days ahead, daily active-request limit, response window, cancellation cutoff, pickup instructions and the switch for new requests. Closing that switch preserves existing orders. Capacity is enforced in the database transaction, prices cannot be changed retroactively, cross-origin mutations are refused, and request creation is rate limited.

M2 still has no platform checkout, settlement, delivery, refund promise or real-time stock claim. Students pay the provider outside the app at pickup according to the provider’s accepted request. A payment milestone requires a separately tested vendor settlement, reconciliation, cancellation and refund design.

## Food M3 implementation (20 October 2026)

M3 adds the operational controls needed to run a small pickup pilot without presenting unverified availability as fact. A linked vendor may update only the provider's current service state, temporary hours, availability note and which verified menu items can be prepared. Provider identity, location, contact, item names and prices remain staff-controlled. Every vendor update and staff pilot decision is recorded in an audit history.

New requests require all four gates: the global staff pilot switch, provider admission, the provider's M2 pickup configuration and a current OPEN or BUSY vendor status refreshed within 18 hours. Any gate can stop new requests without deleting or hiding existing pickups. Editing or suspending a provider removes it from the pilot; staff must verify and admit it again.

Students can report a problem after a provider accepts a pickup and can submit one rating after collection is confirmed. Active cases appear in the staff Food workspace with review, resolution and dismissal actions. The operations dashboard shows request totals, collected, expired and declined counts, average acceptance time, and collection-backed ratings. M3 does not issue refunds, take online payment, promise delivery or infer stock.

## Food M4 implementation (20 October 2026)

M4 adds an independently gated Paystack checkout after vendor acceptance. The charged total, processing fee, platform commission and vendor net are frozen in integer pesewas. Webhook and active verification share one idempotent settlement path; amount or currency mismatches enter review. Payment-enrolled orders cannot move to ready before successful payment.

Cancellation before the existing cutoff records a full refund when money was collected. An administrator approves the refund, and only a processed provider result marks it paid. Collection creates vendor earnings after the configured release delay. Staff record an external payout reference; automatic vendor transfers are deliberately outside this release. The immutable finance projection includes Food payments, paid refunds and earnings transitions.

The deployment-wide payment switch and every provider payment profile default off. M4 does not enable Food on the homepage or add delivery. See `docs/FOOD_PAYMENTS_M4.md` and `sql/042_food_payments.sql`.

## Starting point

The public launcher runs CampusRide, VacationRide, Hostel Finder and OnlineCinema, plus two external partner links. Food and Print & Copy remain in the launcher's “On the way” area while real providers are being verified. The Food service itself is implemented through M1–M4: staff-managed listings and corrections, pickup preorders, vendor operations, gated Paystack checkout, refunds and earnings records. The vendor application and Food console workspace are available. Delivery and automatic vendor transfers are not implemented, and payment enrollment defaults off globally and per provider.

The remaining Food work is operational launch readiness: confirm willing providers, verify and publish accurate listings, link each vendor account to its provider, assign a support owner, and operate the bounded pickup pilot. Enable online payments only after the payment, cancellation, refund, reconciliation and provider payout process is approved and exercised. Do not enable delivery or advertise Food in the launcher before its launch gates pass.

UMaT lists the Students Canteen, SRC Food Joint and hall snack bars as places students eat. It also describes printing and photocopy shops around campus. Its own portal and helpdesk already handle academic records, course registration, LMS help and university fee guidance. New services should help students find and use local services, while linking to official academic systems instead of copying them.

UMaT also publishes a University Clinic contact, operates a Counselling and Student Support Unit, and has identified a pharmacy at its service station. These are existing services to connect students with, subject to confirmation with their operators. Health information, appointments and medicine availability must never be inferred from a directory listing.

## Recommended order

| Rank | Service | Why next | First useful release | Main launch gate |
| --- | --- | --- | --- | --- |
| **Launch readiness** | **Food** | The service is built and remains a public launcher promise; students need real, maintained provider listings and a reliably operated pilot. | Verify and publish willing providers, link their vendor accounts, name support ownership, then run a bounded pickup pilot. | Real provider verification, menu freshness, vendor response, student support, payment and refund operations, and the pilot's safety gates. |
| **Launch readiness** | **Print & Copy** | First release is built; students need real, verified shop details and a reliable quote follow-up process. | Verify and publish willing providers, assign staff follow-up ownership, then pilot directory and no-upload quote requests. | Shop agreement on quotes, file sharing outside the platform, pickup and failed jobs; honor the 90-day quote-record retention window. |
| **1** | **Campus Events** | Gives students a reason to return without introducing delivery or inventory. | Verified SRC, club and university event listings with date, venue, RSVP and reminders. | Clear publisher approval and ownership of event corrections/cancellations. |
| **2** | **Pharmacy** | Helps students find a nearby, verified place for pharmacy services. | Staff-verified location, contact, published hours and directions; link or call the operator directly. | Pharmacy agreement and an owner to keep details current. Stock, reservations and medicine orders require a pharmacy-managed process and review of applicable rules. |
| **3** | **School Clinic** | Makes UMaT's existing clinic easier to find and contact. | Official clinic contact, location, confirmed hours, services overview and clear directions for urgent care. | Clinic approval of every operational claim. Add appointments only if the clinic agrees to manage slots, changes and patient privacy. |
| **4** | **Counselling & Student Support** | Gives students a clear route to UMaT's existing support unit. | Official contact, location, confirmed hours, service overview and a direct link to the unit. | Unit approval of content and escalation guidance. Private appointment requests require the unit to own scheduling, consent and confidentiality. |
| **Later** | **Campus Essentials** (groceries, stationery, laundry) | Could extend provider discovery and ordering after Food's operations are stable. | Start with pickup from a small set of verified providers. | Food vendor fulfilment and support metrics are stable. Do not reuse Hostel Finder's service-plugin money flow while that feature is on hold. |

A student-to-student resale marketplace is **not** an early launch: identity, scams, disputes and hand-off safety make it a separate trust product. Academic records should remain with UMaT. The three health and support entries above are directory and referral concepts first, not commitments to booking, clinical advice or dispensing through the platform.

## Food: launch readiness

Food's directory, pickup preorder, vendor operations and payment code are implemented. The remaining work is to prove that the service can operate safely with real providers:

1. **Recruit and verify providers.** Confirm provider identity, an accountable listing owner, current menu and prices, location, hours, pickup instructions and a correction contact. Publish only after staff review.
2. **Link vendor accounts.** Review each application and confirm the person is authorized to represent exactly one provider before linking the account. Verify that vendor access is limited to that provider and that the provider can maintain service state and item availability.
3. **Run the pickup pilot.** Agree on the response window, pickup instructions, cancellation cutoff and staff support route. Start with online payment disabled unless payment enrollment, reconciliation, refund approval and payout handling have been explicitly prepared and tested.
4. **Review operations before widening access.** Use the Food dashboard and student reports to review response times, completed and expired requests, complaints and ratings. Set pilot thresholds before launch; pause new requests if listings go stale or issues lack an owner.

Keep the launcher card unavailable until verified providers are published and the pilot owner confirms readiness. Delivery, automatic vendor transfers and unverified real-time stock claims remain out of scope.

## Student safety and comfort review

Review each service as a student journey: discover it, understand the offer, decide whether to use it, complete the task, and get help if something goes wrong. A service is not ready for a student pilot while a critical safety, privacy, pricing, or support question is unresolved.

### Readiness gates

The service owner records an answer and evidence for each gate before inviting students to use a pilot:

| Gate | Ready when | Hold the pilot when |
| --- | --- | --- |
| **Accountability** | A named platform owner and provider contact can correct listings and respond to issues. Providers are checked before publication. | No one owns the listing, fulfilment, or student complaint. |
| **Truth and expectations** | Price, availability, hours, location, fulfilment steps, and cancellation terms are clear, dated where they can change, and easy to correct. | A student could reasonably mistake an estimate or stale listing for a guarantee. |
| **Privacy** | Each collected field has a stated purpose, access owner, and retention/deletion rule. Browsing does not require sign-in. | The pilot collects sensitive or unnecessary data, or file/data access and deletion are undefined. |
| **Recovery and support** | Students can find a real support route, report a problem, and understand what happens after cancellation, failure, or a change. | Refunds, failed fulfilment, corrections, or escalation have no named owner or process. |
| **Comfort and access** | The flow works on a phone, uses plain language, shows the next step and full known cost, and does not pressure students to commit. | Students cannot understand the commitment, total cost, or how to stop before submitting. |
| **Real-world setting** | Any pickup or event location and timing are clear, reachable, and reviewed with the provider; the service avoids exposing a student's private location. | Meeting arrangements are ambiguous or students must share more contact/location detail than fulfilment needs. |

An unresolved critical issue is a **hold**, not a score that can be offset by good results elsewhere. Record the issue, owner, and evidence needed to clear it. Define any numerical pilot thresholds before the pilot starts; do not choose them after seeing results.

### Student pilot review

After the readiness gates pass, invite a small, varied group of students to complete realistic tasks on their own phones. Include students who are new to the service and students who may face accessibility or mobility barriers. Explain that participation is optional, do not ask for sensitive personal stories, and provide a way to stop or give feedback privately.

Ask students to:

1. Find a suitable provider or listing and tell you what they believe is currently available.
2. Explain the total known cost, location, timing, and what will happen after they continue.
3. Complete a low-risk task or walk through a prototype without making a real payment or sharing private documents.
4. Find how to cancel, report a problem, correct information, and contact support.

Observe where students hesitate, misunderstand a claim, need help, or feel pressured. After each task, ask what felt unclear or uncomfortable and what information would have helped. Record task completion, errors, questions, support needs, and issues raised; remove names and contact details from review notes. Fix critical issues and repeat the affected tasks before widening access.

### Checks for the first services

| Service | Extra checks before a pilot |
| --- | --- |
| **Food directory** | Confirm each provider and listing owner; show when menus and prices were last checked; explain how students report stale details. Do not imply an item is available now unless the vendor maintains that status. |
| **Food preorder** | In addition to the directory gates, exercise vendor accept/decline, pickup timing, cancellation, late or missing items, refund handling, and who answers each complaint. Payment code exists, but keep its global and provider switches off until payment enrollment, reconciliation, refund approval and payout handling are ready for the pilot. |
| **Print & Copy** | Begin with directory and quote requests. Before file upload exists, approve who can access documents, transfer/storage protection, retention period, deletion, and a no-upload alternative. Test quote changes and failed or late jobs. |
| **Campus Events** | Verify who may publish; show venue, time, cost, age/access requirements where applicable, and update time. Define who corrects or cancels an event. Make RSVP optional unless the organizer needs it. |
| **Pharmacy, Clinic, Counselling** | Obtain operator approval for every listing and referral instruction. Link or call the official provider. Do not collect symptoms, prescriptions, counselling notes, or appointment details in a general platform form. |

Use this review for Food's provider onboarding and pilot, and for discovery and pilots of the unbuilt services. Return with willing providers or publishers, the top student problems, completed gate evidence, unresolved holds, and a recommendation for the smallest safe pilot. This review does not authorize a launch or replace any required operator or platform approval.

## Decisions before building another service

- **Print & Copy privacy:** the first release does not accept uploads and deletes quote records with student contact details after 90 days. Any later upload feature needs its own access, retention, deletion and no-upload design.
- **Student flow:** let students browse without an account; require sign-in only when a transaction or RSVP needs identity. Show the known price, location, timing and cancellation terms before commitment.
- **Operations:** name a service owner, provider contact, correction process, support route and escalation owner for every pilot.
- **Publisher control:** for Events, decide which SRC, club and university publishers may post and who handles changes, cancellations and reports.
- **Health and support:** confirm the official owner, scope, hours and contact route before publishing Pharmacy, School Clinic or Counselling & Student Support. Do not collect symptoms, prescriptions, counselling notes or other sensitive details in a general service form. Keep emergency guidance sourced and approved by the clinic or support unit.

## Next decision

Onboard verified Print & Copy providers and run a small directory and quote-request pilot. In parallel, start discovery for **Campus Events** while completing Food's provider onboarding and pilot-readiness work. Return with willing providers or publishers, the top student problems, operator and support owners, privacy decisions, unresolved safety holds, and a recommendation for the smallest useful pilot. Keep Pharmacy, the Clinic and Counselling as operator-approved referral directories until their owners confirm the content and contact route.

## Sources

- [UMaT Food Joints](https://www.umat.edu.gh/media-press/news/food-joints)
- [UMaT Business Centers](https://www.umat.edu.gh/index.php?Itemid=237&id=221&option=com_content&view=article)
- [UMaT Help Desk](https://helpdesk.umat.edu.gh/)
- [UMaT Portal](https://portal.umat.edu.gh/)
- [UMaT University Clinic contact](https://www.umat.edu.gh/contact-2)
- [UMaT Counselling and Student Support Unit](https://cssu.umat.edu.gh/)
- [UMaT service station pharmacy](https://umat.edu.gh/media-press/speeches/speech-presented-by-the-3rd-vice-chancellor-prof-richard-kwasi-amankwah-on-1st-august-2026-at-the-investiture-ceremony)
- Repository: `components/launcher/services.ts`, `components/admin/console-services.ts`, `lib/console-applications.ts`, `docs/Hostels/HOSTEL_FINDER_SERVICE_PLUGINS.md`
- Print & Copy operating guide: `docs/PRINT_COPY_M1.md`
