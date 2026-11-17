# Print & Copy M1: verified shops and quote requests

**Status:** Implemented in code; public launch awaits real provider verification and an assigned support owner.

## What is available

- `/print-copy` shows only published shops checked within the last 30 days. It displays services, hours, location, indicative pricing, typical turnaround and a direct provider contact. Staff must reconfirm and republish a listing when verification expires.
- `/console/print-copy` lets platform administrators and Print & Copy scoped admin delegates create drafts, verify and publish shops, suspend listings, review quote requests, and resolve correction reports. Other console roles cannot read student quote contact details.
- A signed-in student may submit a short job description to request a quote only after staff enable the global quote switch. The switch starts off and requires a named support owner and at least one currently verified shop. The switch and shop availability are checked in the same database statement that accepts the request.
- Students can see the reference and status of their own active requests on `/print-copy`; status changes also queue a notification to their account email. Internal staff notes and job descriptions are not exposed in this status view.
- Requests contain the student's account name and email, the shop, and the job description. They have a reference and expire after 90 days. A daily scheduled purge at 02:12 UTC deletes expired records even when nobody opens the queue. Staff queue reads are audit logged.

## Start a controlled pilot

1. Apply `sql/049_print_copy_directory.sql`, or the corresponding section of the combined migration. The runtime also creates the tables on first use.
2. In the Print & Copy console, add each shop as a draft. Confirm its identity, named contact, location, services, hours, indicative pricing, turnaround and direct contact link.
3. Enter a verification note naming the provider contact and what was checked, then publish. Editing any listing returns it to draft; verify it again before republishing.
4. Assign a staff member to monitor and answer quote requests. Enter the support owner and explicitly open the quote switch. Confirm the shop's process for receiving files and handling changed prices, late work and failed jobs before inviting students.
5. Process each quote from the staff queue. Contact the shop using its verified route, follow up with the student using the account email, and close the request with a staff outcome note. Students can track status on the public Print & Copy page after signing in. Reconfirm published shop details at least every 30 days; correct stale listings from the reports queue and suspend a shop if its claims cannot be confirmed.
6. Add the public launcher link only after verified shops and quote support are working. The launcher currently lists Print & Copy as **On the way**.

## Data boundaries

The platform does not accept or store print documents, take payments, promise a final price, or guarantee turnaround. Students should not include private documents or sensitive details in the job description. Arrange any document transfer directly with the shop through a method agreed by the student and shop. The platform's quote queue is for staff follow-up; it is not a vendor workspace.
