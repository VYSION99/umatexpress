# Curiosity pilot release record

The production curiosity pilot was enabled at 50% on 2026-11-02 by the project owner's instruction. `CURIOSITY_PILOT_ENABLED=false` remains the immediate kill switch.

## Release record — 2026-11-02

- The project owner chose the already configured Cloudflare account and a 50% initial cohort. The client and console Workers share the signing key and have `CURIOSITY_PILOT_PERCENT=50` and `CURIOSITY_PILOT_ENABLED=true`. Code versions before the secret update were `umatexpress` `50657d2a-f8af-4553-97ce-72dda8ab730f` and `console-umatexpress` `3ef64f44-4052-4773-8234-1dd5be090580`.
- The additive feedback schema was applied to the configured Turso database. The local release tree passed 101 tests, lint, type checking, and build. Live shadow checks passed 11 synthetic scenarios with no policy failures or readiness holds. After activation, 12 fresh browser assignments returned six enabled and six disabled with no errors. An admitted browser received an OnlineCinema suggestion; a direct POST without a signed cohort cookie returned 404. The console summary returned 401 without an in-app session.
- A local production-build preview verified invitation, goal choice, and a checked OnlineCinema suggestion. The mobile preview revealed an install prompt overlapping the feedback controls; the deployed fix hides the prompt while a student is actively using guided discovery. A fresh preview showed the feedback controls unobstructed. Full keyboard and screen-reader QA with students remains open.
- The owner explicitly chose to activate the pilot without Cloudflare Access. The account has no Access applications; the administrator will provide the staff and organizer allowlist later. The console continues to rely on its in-app session.
- A named operational contact, student comfort and task-completion review, and full keyboard and screen-reader QA are still open after activation. No numeric complaint or discomfort threshold was supplied; serious issues trigger the immediate stop rule below.

## Configuration

- `CURIOSITY_PILOT_SIGNING_KEY`: at least 32 random characters, kept in the ignored local `.env` and Worker secrets, never committed. Push the same value to the client and console Workers and keep it stable while a seven-day cohort is active.
- `CURIOSITY_PILOT_PERCENT`: integer from 1 to 100; the safe example default is 5. Production is currently 50. This is an exposure percentage, not an exact participant count. Clearing browser storage can produce a new assignment.
- `CURIOSITY_PILOT_ENABLED`: global kill switch. `false` is the default and fails closed if the key or Turso is missing.
- `CURIOSITY_EXCLUDED_SERVICES`: comma-separated service IDs to remove from recommendations. Set `none` to clear a previously pushed exclusion. Existing service cards remain available.

`scripts/push-secrets.sh` includes these keys for the selected Worker. Push them to both client and console Workers when the console runs separately. Deploying code alone does not turn the pilot on.

## Operational checks and follow-up

1. Name the owner who reviews every catalog explanation and can turn the pilot off. Record the owner and how to reach them in the release record.
2. Run `npm test`, `npm run typecheck`, and `npm run lint` against the exact release tree. All must pass.
3. Apply `sql/050_curiosity_feedback_daily.sql` or verify the runtime-created tables on a production-like Turso database. Confirm the daily cleanup cron is installed.
4. With the switch on in a restricted preview environment, verify an ineligible browser sees no pilot, an eligible browser sees the invitation, and direct POSTs without the signed cohort cookie fail. Confirm hidden, excluded, and unavailable services abstain.
5. Use only test feedback in preview. Confirm a suggestion produces a short-lived receipt, a valid rating counts once per browser, service, policy, and day, retries do not increase the total, and an invalid or other-browser receipt fails. Inspect the console summary under the primary administrator.
6. Check the launcher with keyboard only and a screen reader on desktop and mobile: join, goal choice, optional question, suggestion explanation, dismiss, skip, reset, leave, and turn off. Confirm focus is visible and the optional question is announced.
7. Ask students in the pilot whether they completed their intended task and whether the flow felt clear and comfortable. Review complaints and service failures alongside helpfulness totals. The dashboard totals alone do not establish success.
8. Cloudflare Access is deferred at the owner's instruction. The configured account returned zero Access applications in a read-only check on 2026-11-02; the in-app console session remains the current protection.

Stop the pilot immediately for any unsafe or false availability claim, a hidden or excluded service recommendation, a transaction caused by a suggestion, or a serious accessibility or privacy issue. Set `CURIOSITY_PILOT_ENABLED=false` on both Workers; use `CURIOSITY_EXCLUDED_SERVICES` for a service-specific hold. The owner approved the 50% population; define acceptable comfort and task-completion results before any expansion.
