# Hostel Finder — landlord onboarding and review

**Status:** Core onboarding and approval gates implemented. Remaining UX and verification work is listed below.

## Decision and intent

Use a three-step, save-and-resume onboarding flow. A landlord may create an account and prepare a property, but **listing creation belongs in the signed-in Hostel Finder workspace and unlocks only after owner identity is approved**. Approval of one step never silently approves another. A public listing requires its own listing decision as well as the relevant owner and property approvals. A student may book it only when the payout destination is validated.

The landlord application now signs the owner in and directs them to the three-step setup. The property and listing workspace remains available behind the appropriate identity and review gates.

## The three onboarding steps

| Step | Owner enters | Review outcome | What the owner may do |
| --- | --- | --- | --- |
| **1. Account and owner details** | Legal name, phone, email, password, business or hostel name if applicable, and whether they own or are authorized to manage the property. | Contact verification and account-profile review are recorded separately from identity and property review. | Sign in, save progress, and begin a property draft. |
| **2. Property details** | Property name and address; address search followed by a confirmed map pin; affiliation claim; amenities, utilities and safety details; rooms and beds; property and room media. | Staff decide the property review independently. Location, affiliation and photos each retain their own evidence and review record. | Revise a returned property without restarting account registration. |
| **3. Identity and payouts** | Accepted identity evidence, proof of ownership or management authority, and a payout destination: mobile money or bank. | Staff approve or return identity evidence. The payout destination has its own validation and change history; saving an account is not identity approval. | Once identity is approved, create and manage bed listings in the workspace. |

The stepper shows **Not started**, **Draft**, **Submitted**, **Needs changes**, or **Approved** for each step. It persists progress across devices, names the missing item, and links directly to the field that needs correction. Completing the form means *submitted for review*, never *approved*.

## Stepper layout

On **desktop and laptop**, use a narrow left step rail with the three step names and review statuses, a focused form in the center, and a right-hand checklist showing missing evidence and what approval unlocks. Keep each form section a readable width; use the extra screen space for context and photo previews rather than stretching inputs.

On **iOS and Android phones**, use one form column with a compact “Step 2 of 3” header, the current step name, and a visible save state. Keep **Continue** and **Save and exit** reachable above the safe area and keyboard. Split long property details into short sections within Step 2; the step count remains three. Use the device's file picker and date inputs, show upload progress, and preserve typed values if an upload fails.

The final screen summarizes each step separately: **Approved**, **Under review**, or **Needs changes**, with a direct link to correct only the affected details. The same progress and review decisions must appear later in the signed-in workspace.

## Property location and affiliation

Address search should suggest places and fill an address and coordinates, then require the owner to check the pin on a map. Manual address entry and pin adjustment remain available when a suggestion is wrong or missing. The owner sees the final saved address and pin before submission. Staff review the claimed location; a geocoding result alone is not a staff verification.

Affiliation choices are **UMaT-affiliated**, **Independent**, and **Unsure**. An affiliation choice is a claim. Only an explicit university or authorized staff verification record may produce a public “UMaT-affiliated” badge. Independent properties can still be reviewed and listed without implying university endorsement.

Photos and room media follow the existing approval process. A property approval does not automatically approve later uploads or edits. Material changes to location, utilities, safety details or affiliation reopen the affected review; the public verified claim is removed until checked again.

## Workspace and publication gates

1. **Account created:** owner can sign in and save a property draft. No listing form is available yet.
2. **Property submitted:** staff review property details, location, affiliation evidence and media. A returned property shows a reason and can be corrected.
3. **Identity approved:** the signed-in workspace unlocks creation and editing of bed listings for that owner. This does not publish a listing or approve a property.
4. **Property approved:** listings for that property may be submitted for listing review. Any unapproved photo or claim remains hidden from students.
5. **Listing approved:** an approved listing attached to an approved account profile, approved property and approved owner identity may become public. A listing price or other material offer change returns that listing to review. Listing approval does not bypass payout readiness.
6. **Booking ready:** a student may book and pay only while the owner identity and payout destination are both approved and current. If payout validation is pending, show the listing as **booking paused** in search and on its direct page; never present a working booking button until the destination is approved. A payout destination change pauses new bookings and transfers until the new destination is validated; existing bookings and records remain intact.

These gates must be enforced by server-side state checks, not only by hiding buttons. Review decisions need the reviewer, timestamp, evidence reference and reason. An owner with several properties completes owner identity review once, while each property and each listing has its own review.

## Review console

Provide separate queues or filters for **Account/profile**, **Property**, **Identity**, **Payout destination**, **Photos**, and **Listings**. Each review screen shows only the evidence relevant to its decision, a clear approval or return action, and the downstream effect. Returning one step must not erase approvals on unrelated steps. A reviewer can see the overall readiness summary without giving one blanket approval.

Suggested readiness summary:

| Gate | Example status | Effect |
| --- | --- | --- |
| Owner identity | Approved | Listing editor unlocked |
| Property | Needs changes | Listings remain drafts and cannot be submitted |
| Photos | Two pending | Pending images remain private |
| Listing | Pending review | Bed is not public |
| Payout destination | Not validated | New student bookings and transfers are paused |

## Open product decisions

- Decide which identity and ownership documents are accepted, who may review them, how long they are retained, and how the owner can replace a rejected document. Keep sensitive files private and show only the minimum needed to reviewers.
- Decide how an individual owner, a company owner and an authorized manager differ in account and evidence requirements. A manager must not be able to change the owner's payout destination.
- Decide whether a property may be submitted before every room is created. A property can be approved separately from a later room or listing change, but the review criteria need to be explicit.

## Implemented behavior and follow-up

The setup page at `/console/hostels/onboarding` saves account details, property drafts, room and photo inputs, private identity/authority files, and a MoMo or bank destination. The staff desk records separate account, identity, payout and property decisions; photos and listings keep their separate queues. The server enforces identity approval before listing creation, account and property approval before listing submission, and current payout approval before a booking or transfer. A payout edit resets that approval.

The first release uses a simple three-step status rail. Contact verification, granular per-field verification records, document retention rules, a richer final readiness checklist, and finer-grained verification states remain follow-up work. While payout review is pending, an otherwise approved property remains visible with a booking-paused notice, and booking is blocked server-side. Staff should verify an affiliation claim before approving the property; the claim is never published as a university badge from owner self-report alone.

## Room pricing and the hostel information desk

A room records its bed layout as separate beds or bunks and its capacity as individual bookable student bed spaces. One bunk unit has two spaces, an upper and a lower bed; bunk-only rooms therefore have an even capacity. A four-person bunk room contains two bunk units and four separately bookable spaces. For each academic year, the owner sets **one annual rent per student bed for the whole room**. A four-bed room therefore creates four separate bed offers at the same rent; four students can each book one bed until the room is full. The entered price is never the total rent for all four beds. A room-rate change updates every bed offer together and sends changed offers back to listing review. A held or occupied bed prevents a conflicting price change in that academic year. Utilities are shown separately where applicable.

The hostel information desk lets the owner or an active delegated manager/assistant maintain property-wide and room-specific answers (for example, visitor rules or a room's furnishing). The public assistant uses these as **hostel-supplied claims**, alongside the approved public listing facts, and does not present them as independently verified. If a question is not covered or needs a decision about the student's own circumstances, the assistant offers a staff handoff. The student supplies a name and reply email; the inquiry enters that property's staff inbox, where an authorized host can answer. The reply is queued to the student's email. Staff should keep the source information current and should not use the assistant to promise bed availability or override booking and approval gates.
