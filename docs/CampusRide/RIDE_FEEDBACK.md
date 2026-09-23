# CampusRide Rating a Trip, and Reporting It

**Status:** implemented — a score lives on the driver's record, a complaint lives in the dispute queue
**Applies to:** the student ticket, the driver console, the campus console, `campus_ratings`, `trip_disputes`

---

## 1. Two acts, two homes

A passenger has two things to say after a trip and they are not the same kind of
thing, so they do not go to the same place.

| | A **rating** | A **report** |
|---|---|---|
| What it is | a score on the driver's record | a complaint someone must decide about |
| Where it lives | `campus_ratings`, one row per seat | `trip_disputes`, with a decision recorded against it |
| Who reads it | the driver, as their own average | an administrator, in the queue they already triage |
| What it can do | nothing by itself | hold a resolution, a note and a name |

Collapsing the two is what makes each worse. A rating that becomes a support
ticket is a rating a driver learns to game; a complaint that becomes a rating is
a passenger learning that nobody read it.

## 2. The rating

- **One row per seat.** Two taps on the same trip edit the same row rather than
  voting twice, so a driver's average cannot be moved by submitting again.
- **One to five, nothing else.** A score outside the band is refused, and so is
  a score on a trip that is not `COMPLETED` — there is nothing to judge from
  inside the vehicle.
- **Never a single review.** The driver sees an average and a count, and nothing
  else. Nobody sees the comment, and no passenger is identified to the driver.
- **An average is withheld until it means something.** Below
  `CAMPUS_RATING_VISIBLE_COUNT` (three) the count is shown but the average is
  *suppressed in the payload*, not merely left unlabelled — one bad trip out of
  two is not a 2.5-star driver, and showing it as one teaches drivers to avoid
  the passengers most likely to complain. A consumer that forgets to check
  `visible` still cannot leak it.
- **An optional line.** 500 characters, stored with the score. Most students
  only tap a score, and that is a complete answer.

## 3. The report

The passenger picks what kind of problem they had and writes what happened. The
category becomes the subject, because asking someone who is upset to also title
their own complaint is how a complaint stays unwritten. The details need a
sentence or two, which is the same bar `openDispute` already enforces.

It lands in `trip_disputes` — the queue the console already reads — carrying the
campusRide reference on a new `campus_reference` column, and it shows up in
`/console/disputes` beside vacationRide complaints rather than in a second list
nobody opens. The role is `STUDENT` and the ownership check is the seat's own
email, so a guessed reference cannot file a complaint in a stranger's name.

**A report never moves money.** It records a judgement; the repayment is made
where every other money movement is made, exactly as the dispute module's own
contract says.

## 4. Who sees what

| Surface | Shows |
|---------|-------|
| `/campus/ticket` | after a `COMPLETED` trip: a score row, an optional line, and "Something went wrong" |
| Driver console | their own average once three trips are rated, with the count either way |
| `/console/campus` | the average, the rated-trip count, comments, and a per-driver table **sorted weakest average first** |
| `/console/disputes` | every report, with the campusRide reference on the row |

The console ranks drivers weakest-first, and answers the only question a rating
desk exists to answer: *which runs need a look*. Newest-first answers a different
question.

## 5. Ownership and access

Rating, reporting and reading the feedback state all go through one door,
`requireCampusPassenger`: the one-hour payment cookie a guest is handed at
checkout, or the signed-in account the booking was made under. Cancelling uses
the same door, so the four passenger actions on a seat cannot drift into four
different notions of who owns it.

## 6. What is deliberately not here

- **Public star ratings.** A student choosing a route should not be picking
  between drivers on a 4.6 versus a 4.4; the platform assigns the vehicle. The
  average is an operations signal, not a marketplace.
- **Automatic suspension on a low average.** A rating is a prompt for a human
  look, not a verdict with a sentence attached. If operations ever wants a
  threshold that takes a route off the board, that decision belongs next to
  driver suspension where a reason is recorded.
- **A reply channel on a rating.** Ratings are not correspondence. A passenger
  who wants an answer files a report, and then a person answers.

## 7. Files

| Concern | Where |
|---------|-------|
| Ratings, the threshold, the report and the breakdown | `lib/campus-engine/feedback.ts` |
| The shared door | `lib/campus-engine/passenger-access.ts` |
| The passenger's endpoint | `app/api/campus/feedback/route.ts` |
| The console read | `app/api/console/campus/feedback/route.ts` |
| The ticket's feedback panel | `components/campusRide/student/TripFeedback.tsx` |
| The driver's own record | `lib/campus-engine/driver-summary.ts` → `rating` |
| The console panel | `components/campusRide/admin/CampusFeedbackPanel.tsx` on `/console/campus` |
| The dispute record | `lib/disputes.ts` → `openDispute`, `campus_reference` |

## 8. Tests

`tests/campus-feedback.test.mjs` holds it: a completed trip can be rated and a
second thought edits the same row, nothing can be rated or reported before the
trip is over, the score band is enforced, an average is withheld below three
rated trips while the count is always shown, the breakdown ranks the weakest
first, a report becomes a dispute carrying the ride, and the endpoint refuses a
stranger while accepting the ticket's own owner.
