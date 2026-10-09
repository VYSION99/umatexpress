# Next student services roadmap

**Planning date:** 27 September 2026
**Status:** Recommendation for discovery; no new service is approved or marked live by this document.

## Starting point

The public launcher already runs CampusRide, VacationRide, Hostel Finder and OnlineCinema, plus two external partner links. **Food is its only public “Coming soon” service.** The console does not show a Food workspace until one exists. Its vendor application is described in `lib/console-applications.ts`, but remains `COMING_SOON`; the vendor handler, menu, order and fulfilment flows do not exist. The platform has student accounts, provider review patterns, payments, notifications and private object storage that can inform a new service, but these are not a ready-made food marketplace.

UMaT lists the Students Canteen, SRC Food Joint and hall snack bars as places students eat. It also describes printing and photocopy shops around campus. Its own portal and helpdesk already handle academic records, course registration, LMS help and university fee guidance. We should help students find and use local services, while linking to official academic systems instead of copying them.

UMaT also publishes a University Clinic contact, operates a Counselling and Student Support Unit, and has identified a pharmacy at its service station. These are existing services to connect students with, subject to confirmation with their operators. Health information, appointments and medicine availability must never be inferred from a directory listing.

## Recommended order

| Rank | Service | Why next | First useful release | Main launch gate |
| --- | --- | --- | --- | --- |
| **1** | **Food** | Already promised in the launcher; frequent student need and visible campus supply. | Verified food-joint directory with menus, price and opening-hours timestamps, location, pickup details and direct contact. Pilot preorder pickup only after vendors can reliably accept or decline requests. | Named vendor owner for every listing; menu freshness and order/support process. |
| **2** | **Print & Copy** | Existing campus providers and a recurring academic errand. | Shop directory showing services, hours, location, indicative prices and turnaround; request a quote for printing/binding. | Shop agreement on quotes, file access, pickup and handling of failed jobs. |
| **3** | **Campus Events** | Gives students a reason to return without introducing delivery or inventory. | Verified SRC, club and university event listings with date, venue, RSVP and reminders. | Clear publisher approval and ownership of event corrections/cancellations. |
| **4** | **Pharmacy** | Helps students find a nearby, verified place for pharmacy services. | Staff-verified location, contact, published hours and directions; link or call the operator directly. | Pharmacy agreement and an owner to keep details current. Stock, reservations and medicine orders require a pharmacy-managed process and review of applicable rules. |
| **5** | **School Clinic** | Makes UMaT's existing clinic easier to find and contact. | Official clinic contact, location, confirmed hours, services overview and clear directions for urgent care. | Clinic approval of every operational claim. Add appointments only if the clinic agrees to manage slots, changes and patient privacy. |
| **6** | **Counselling & Student Support** | Gives students a clear route to UMaT's existing support unit. | Official contact, location, confirmed hours, service overview and a direct link to the unit. | Unit approval of content and escalation guidance. Private appointment requests require the unit to own scheduling, consent and confidentiality. |
| **Later** | **Campus Essentials** (groceries, stationery, laundry) | Could reuse vendor discovery and ordering once Food operations work. | Start with pickup from a small set of verified providers. | Food vendor fulfilment and support metrics are stable. Do not reuse Hostel Finder's service-plugin money flow while that feature is on hold. |

A student-to-student resale marketplace is **not** an early launch: identity, scams, disputes and hand-off safety make it a separate trust product. Academic records should remain with UMaT. The three health and support entries above are directory and referral concepts first, not commitments to booking, clinical advice or dispensing through the platform.

## Food: the first build slice

1. **Discover the real demand.** Interview students from halls and off-campus hostels, the Students Canteen/SRC Food Joint, and independent food sellers. Confirm whether the pain is finding current menus, opening hours, queue time, preorder pickup or delivery. Count how often published prices and availability change.
2. **Directory pilot.** Give each approved vendor a profile, location, contact, hours, menu items, prices, dietary/allergen information supplied by the vendor, and a visible “last updated” time. Let students report stale information. Staff review vendors before publication. Do not show an “open now” or “available” claim without an owner and update mechanism.
3. **Pickup preorder pilot.** Add a bounded order window, vendor accept/decline, pickup time, student order status and cancellation handling. Start with pickup, not delivery. Define who answers late/missing-item complaints before accepting payment. Keep payment disabled until the acceptance, refund and reconciliation paths are tested end to end.
4. **Expansion gate.** Add more vendors only when menus stay current, vendors acknowledge orders within the agreed window, and support can resolve failed orders. Measure repeat use and completed orders, not only page visits.

The vendor application should change from `COMING_SOON` only when its endpoint, review queue, account role and vendor workspace actually work. The public Food card should remain nonclickable until the directory has verified listings. Do not open the ordering surface merely because the directory is ready.

## Shared decisions before coding orders

- **Operator and settlement:** decide who takes payment, who fulfils each order, when a vendor is owed money, and how a declined, late or missing order is refunded. Reuse the platform's provider review and payment-event patterns, but specify Food's own states and ledger.
- **Listing truth:** vendor-edited menus need review or audit history, timestamps and a way to mark items unavailable. Staff need a route to suspend misleading listings.
- **Student flow:** browse without an account; require sign-in only when an order or RSVP needs identity. Show final price, pickup point and cancellation terms before payment.
- **Privacy:** collect only the contact and order information needed for fulfilment. For Print & Copy, decide file retention and access before accepting document uploads.
- **Operations:** each pilot needs a named support owner, provider contact, escalation path and published service hours.
- **Health and support:** confirm the official owner, scope, hours and contact route before publishing Pharmacy, School Clinic or Counselling & Student Support. Do not collect symptoms, prescriptions, counselling notes or other sensitive details in a general service form. Keep emergency guidance sourced and approved by the clinic or support unit.

## Next decision

Run a short discovery sprint for **Food** and **Print & Copy** before choosing the first transaction flow. Bring back a list of willing providers, the top three student problems, and a sketch of the acceptance/refund process. If vendors cannot keep menus current or accept pickup orders, launch Food as a verified directory first and build Events next while the ordering operation is prepared.

## Sources

- [UMaT Food Joints](https://www.umat.edu.gh/media-press/news/food-joints)
- [UMaT Business Centers](https://www.umat.edu.gh/index.php?Itemid=237&id=221&option=com_content&view=article)
- [UMaT Help Desk](https://helpdesk.umat.edu.gh/)
- [UMaT Portal](https://portal.umat.edu.gh/)
- [UMaT University Clinic contact](https://www.umat.edu.gh/contact-2)
- [UMaT Counselling and Student Support Unit](https://cssu.umat.edu.gh/)
- [UMaT service station pharmacy](https://umat.edu.gh/media-press/speeches/speech-presented-by-the-3rd-vice-chancellor-prof-richard-kwasi-amankwah-on-1st-august-2026-at-the-investiture-ceremony)
- Repository: `components/launcher/services.ts`, `components/admin/console-services.ts`, `lib/console-applications.ts`, `docs/Hostels/HOSTEL_FINDER_SERVICE_PLUGINS.md`
