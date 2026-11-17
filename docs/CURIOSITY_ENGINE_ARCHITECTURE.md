# Curiosity engine: architecture and policy

**Status:** M1 deterministic policy, M2 synthetic shadow diagnostics, and the opt-in student pilot flow are implemented. The production pilot is enabled for a 50% browser cohort as of 2026-11-02; the code default remains off when `CURIOSITY_PILOT_ENABLED` is absent. No model training or AI language layer is enabled.

## Purpose and boundary

Help a student discover a useful UMaTeXPRESS service or short path of services from a goal they choose to share. The engine may **suggest**, **ask one optional clarifying question**, or **stay quiet**. It does not book, pay, submit a quote, contact a provider, or change account settings. Those actions remain in the existing service flows and require the student's explicit action.

The first surface is one optional suggestion near the launcher. The main service cards and navigation retain the order, pins, and hidden choices managed by `components/launcher/services.ts` and `components/launcher/useLauncherLayout.ts`. The current 50% pilot is an explicit release decision; remaining comfort and accessibility checks are tracked in `docs/CURIOSITY_PILOT_RELEASE.md`.

## Decision model

```text
Student's stated goal or broad intent
             │
             ▼
Goal interpreter ──► minimal, short-lived goal context
             │
             ▼
Server capability catalog + live readiness adapters
             │
             ▼
Policy gate (launch, eligibility, freshness, privacy, preferences)
             │
             ▼
Decision policy + short-path composer ──► suggest | ask once | abstain
             │
             ▼
Explanation and optional link to the existing service flow
```

The policy gate runs before any relevance score or learned model. A high score cannot make a blocked service eligible. `ABSTAIN` is a normal, successful result when evidence is missing or a suggestion would add work without clear benefit.

### Components and ownership

| Component | Responsibility | Trust boundary |
| --- | --- | --- |
| Launcher preference adapter | Reads the student's existing local order, pins, and hides. | Hidden service IDs are sent only for the current decision and are not stored on the server. |
| Goal interpreter | Maps an explicit choice or short goal to broad intents and missing decision fields. | Raw text stays in the current request and is not written to logs or learning events. The first version uses deterministic parsing. |
| Capability catalog | Defines service IDs, supported intents, task inputs and outputs, destinations, external-link status, required evidence, and allowed explanation templates. | Server-controlled. It extends, rather than trusts, the client launcher registry. |
| Readiness adapters | Ask each service for its current launch switch, provider/listing readiness, verification age, and other relevant gates. | Existing service code remains the source of truth. Missing or failed checks return unavailable. |
| Policy engine | Applies the non-negotiable rules below and emits reason codes. | Runs server-side for every decision. The client cannot override eligibility. |
| Decision engine | Chooses one eligible suggestion, a short path of eligible services, one useful question, or abstention. | May optimize usefulness only within the eligible set; each path step passes policy independently. |
| Explanation renderer | Shows a plain reason, relevant uncertainty, and a direct route to the service. | Uses approved templates and checked facts, not invented claims. |
| Evaluation pipeline | Measures helpfulness, dismissals, errors, and safety outcomes for an approved pilot. | No persistent personal event stream in the first release. |

`available: true` in the launcher is necessary but insufficient for a suggestion. Food and Print & Copy currently remain **On the way** in that registry, even though some routes exist. External partner links require a separate inclusion decision and a clear external-site label.

### Suggested contracts

These describe boundaries, not a required database schema:

```ts
type CuriosityIntent = "travel" | "housing" | "food" | "print" | "social" | "research" | "unknown";

type CuriosityContext = {
  intent: CuriosityIntent;           // chosen or derived from this request
  goalFields: Record<string, string>; // checked against an intent-specific allowlist
  hiddenServiceIds: string[];       // existing on-device preference
  pinnedServiceIds: string[];
  questionsAsked: number;           // current goal only
};

type ServiceReadiness = {
  serviceId: string;
  launched: boolean;
  eligible: boolean;
  checkedAt: string;
  evidenceExpiresAt?: string;
  reasonCode?: string;              // e.g. NOT_LAUNCHED, NO_VERIFIED_PROVIDER
};

type CuriosityDecision = {
  kind: "SUGGEST" | "SUGGEST_PATH" | "ASK" | "ABSTAIN";
  serviceIds?: string[];             // at most three, in the student's stated order
  questionId?: string;
  reasonCode: string;
  explanationKey?: string;
  policyVersion: string;
};
```

The client may display an already approved decision, but the service route must recheck its own transaction gates when the student acts. A suggestion is never proof that a seat, bed, meal, print slot, price, or provider is still available.

M1 implements `SUGGEST`, `ASK`, and `ABSTAIN` for explicit intent buttons. `SUGGEST_PATH` is reserved for a later milestone when short-path composition and per-step explanations have their own tests. Free-text goals and model calls are not part of M1.

Proposed code boundaries are `lib/curiosity/catalog.ts` for capability definitions, `lib/curiosity/readiness.ts` for existing-service adapters, `lib/curiosity/policy.ts` for hard rules, and `lib/curiosity/decide.ts` for the pure decision function. `POST /api/curiosity/decision` may accept a capped, optional goal and local preference IDs; it needs same-origin validation, input allowlists, and rate limiting, and must work for guests without reading student-account records. The launcher component renders the returned decision and never evaluates readiness itself.

## Policy hierarchy

Apply these rules in order. A later rule cannot reverse an earlier rejection.

| Priority | Rule | Required behavior |
| --- | --- | --- |
| P0 | **Launch and operational readiness** | Suggest only services marked live in the launcher **and** allowed by their current server-side readiness adapter. Exclude missing, suspended, stale, unsupported, or ownerless offers. |
| P1 | **Student control** | Never suggest a hidden service. Do not reorder pinned cards or the main launcher. Provide a visible dismiss and turn-off control for the optional suggestion. |
| P2 | **Truthful claims** | Explain why the suggestion fits the stated goal. Mark estimated prices, opening hours, turnaround, and availability as estimates unless a live source proves otherwise. Show the checked date when freshness matters. |
| P3 | **Sensitive boundaries** | Do not infer health, counselling, financial hardship, religion, disability, or other sensitive needs from behavior. For an explicit health or counselling request, show only operator-approved referral information; no personalized ranking or automated triage. |
| P4 | **Minimal interaction** | Ask at most one optional question per goal. Ask only if its answer can change the next useful step. Include “Skip”; do not block ordinary browsing. |
| P5 | **No autonomous commitment** | Never submit a form, place an order, reserve capacity, send a message, make a payment, or open an external partner site without a student action. |
| P6 | **Calm presentation** | Use at most one suggestion card at a time. An expanded path has at most three steps, each with its own uncertainty and commitment. Do not use countdowns, fear, scarcity claims, repeated prompts after dismissal, or engagement-maximizing notifications. |
| P7 | **Abstention** | If the goal is unclear, facts are stale, no service qualifies, or explanation cannot be supported, return `ABSTAIN` and leave normal navigation available. |

The suggestion can be dismissed for the current visit. A repeated dismissal of the same service should suppress that suggestion on this device for seven days; clearing browser storage or resetting suggestions removes this local choice. This suppression rule does not hide the service from ordinary navigation.

## Ask, suggest, or abstain

First derive the eligible set. Then compare **expected help with the student's goal**, **value of one answer**, **student effort**, and **risk of a wrong claim**. These are policy terms, not a mandate to collect more data. The first version uses explicit, reviewed rules; any numerical weights are pilot configuration and must be set before observing pilot outcomes.

```text
if no eligible service: ABSTAIN
if one approved question changes which eligible path is useful
   and questionsAsked == 0: ASK
if the student explicitly states a multi-step goal and every step qualifies:
   SUGGEST_PATH with at most three steps
if an eligible service clearly serves the stated goal: SUGGEST one
otherwise: ABSTAIN
```

Examples:

- “I need to bind my project tomorrow.” Print & Copy is currently unavailable in the launcher, so the engine must not recommend it as a live service. After launch, it may show recently verified shops and their indicative terms; it must not promise next-day completion.
- “I need to travel home.” An eligible VacationRide route may be suggested. If a travel date is needed to choose a route, one optional date question is allowed; the booking flow still verifies seats and fare.
- “I need to print work and then travel home.” Only after both services are launched and ready may the engine show a two-step path. It must not infer the route, book a seat, or treat an indicative print price as final.
- “I feel unwell.” Do not infer a diagnosis or rank providers. If an approved Clinic directory exists, show its official contact and hours with a human-help route. Otherwise abstain from a service recommendation.

## Learning and privacy policy

**First release:** no model training, cross-service behavioral profile, raw goal logging, or off-device personal recommendation history. The launcher continues to store student preferences locally. The opt-in pilot stores voluntary helpful/not-useful counts grouped by day, service, and policy version. It also stores a random signed cohort cookie for seven days and a one-day opaque hash per cohort, service, policy, and day, so repeat ratings do not increase totals. Neither table stores student IDs or goal text. Pilot rate limits use the anonymous cohort nonce so students behind a shared campus IP do not block each other. Expired limiter windows are purged daily.

**Later pilot, only after a privacy review:** record the minimal event needed to evaluate a policy: broad intent bucket, eligible service IDs, chosen action, policy version, sampling probability, optional dismissal/helpfulness result, and time. Do not record email, name, phone, precise location, quote text, booking details, health text, or full prompts. Delete row-level pilot events after 30 days; keep only non-identifying aggregates needed for the agreed evaluation. Publish a reset and opt-out path before collection starts.

The learning objective is **successful, understood tasks with low burden**, not click-through rate or time spent. Compare usefulness with dismissals, mistaken claims, complaints, accessibility issues, and service failures. Exploration stays in the optional suggestion slot; the student's launcher layout is the baseline. A contextual bandit may be evaluated only after a pilot supplies enough valid outcomes and a human owner approves its safety thresholds. Research supports active preference questions and conservative exploration, but the local pilot must establish whether either helps these students. [Usage-related questions](https://research.google/pubs/soliciting-user-preferences-in-conversational-recommender-systems-via-usage-related-questions/), [conservative bandits](https://proceedings.mlr.press/v48/wu16.html).

An AI language layer is optional and later. It may interpret a student's explicit goal and draft wording from approved capability data. Provider descriptions and other user-generated text are data, never instructions. It cannot change policy results, invent current availability, or call transaction routes. Sending goal text to an external model requires separate data-processing approval and a clear student choice.

## Rollout and verification

1. **Catalog and rules:** the M1 catalog, readiness adapters, versioned policy, and deterministic tests are implemented. The feature remains off by default. Hidden, unlaunched, unavailable, and sensitive cases are tested; stale listing checks use the existing public listing projections.
2. **Synthetic shadow evaluation:** implemented at `/console/curiosity` for the primary administrator. It runs fixed example goals against one live readiness snapshot and reports policy violations, data-source readiness holds, reason codes, and approved suggestion text separately. It does not read student sessions, use actual student goals, or store personal events. Passing these checks is not evidence of student usefulness.
3. **Small opt-in pilot:** implemented behind the default-off server switch, a signed anonymous cohort cookie, and a configurable exposure percentage (5% by default). The student explicitly chooses “Try guided discovery” before goal buttons appear, can leave or turn off the pilot, and can skip feedback. One suggestion includes approved reasoning, a dismiss control, and an optional helpful/not-useful response. The response requires a signed suggestion receipt; only one rating per browser, service, policy, and day is counted. Keyboard and screen-reader checks and direct student assessment of task completion and comfort remain required before a public rollout.
4. **Constrained learning:** only if the pilot improves useful outcomes without increasing confusion or complaints, test a small policy against the fixed baseline. Keep a global kill switch and per-service exclusion switch. Roll back on a safety or accuracy failure.

Acceptance checks include: a hidden or unlaunched service is never suggested; a stale provider cannot create a current-availability claim; one goal triggers at most one question; no suggestion can commit a transaction; unsupported claims produce `ABSTAIN`; and the decision's policy version and reason code can be inspected without exposing the student's text.

For a local pilot, set `CURIOSITY_PILOT_ENABLED=true` with Turso configured and a separate `CURIOSITY_PILOT_SIGNING_KEY` of at least 32 random characters. `CURIOSITY_PILOT_PERCENT` defaults to 5 and may be set from 1 to 100. `CURIOSITY_EXCLUDED_SERVICES` removes a service from suggestions. `GET /api/curiosity/decision` assigns an anonymous seven-day cohort cookie and reports only whether that browser is eligible. Both POST routes require an eligible signed cookie. The feedback route additionally requires a signed, 15-minute suggestion receipt and counts at most one rating per cohort, service, policy, and day. The dashboard shows the most recent 90 days of daily aggregates; expired aggregate and dedupe rows are pruned daily. Neither API accepts free-text goals. Percentage sampling is an exposure control, not a strict participant count: do not enable a public pilot until the named owner and student review below are complete.

## Open decisions before public rollout

- Name the product owner who approves capability claims, pilot event definitions, and the kill switch.
- Decide whether the first interface accepts only intent buttons or also a short free-text goal. Intent buttons avoid collecting text and are the default pilot choice.
- Agree on the opt-in pilot population and thresholds for stopping the pilot before collecting outcome data. The interface uses a helpful/not-useful/skip question and explains that feedback is stored only as daily service totals.
- Decide separately whether external partner services may enter the candidate set. Until then they remain in ordinary navigation only.
