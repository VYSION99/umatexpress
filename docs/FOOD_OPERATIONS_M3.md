# Food M3 — Controlled pickup operations

**Status:** Implemented behind default-off global and provider gates
**Implemented:** 20 October 2026

## Release boundary

M3 prepares Food for a small real-provider pilot. It does not activate the homepage card, admit a provider automatically, take online payment, arrange delivery, issue refunds, or claim that a menu item is in stock.

A student can create a new pickup request only when:

1. platform staff enable the global Food pilot and publish a support contact;
2. staff admit the published provider to the pilot;
3. staff enable the provider's bounded M2 preorder configuration;
4. the linked active vendor marks the service OPEN or BUSY; and
5. at least one verified menu item is currently available.

Pausing any gate blocks new requests. Existing requests remain visible and follow their normal accept, decline, ready, collect, cancel or expiry path.

An OPEN or BUSY operational update is valid for 18 hours. After that, the public page marks it as requiring an update and the API blocks new requests until the vendor refreshes the status.

## Vendor workflow

The Food vendor console now has a **Today's availability** panel. A linked vendor may change:

- OPEN, BUSY or CLOSED;
- the current operating-hours message;
- a short student-facing availability note; and
- availability for existing verified menu items.

The vendor cannot edit the provider's identity, location, contact, verified menu names or prices. Every operation update stores the actor, timestamp and before/after snapshot. When staff edits the provider record, it returns to draft, closes, and leaves the pilot until it is checked again.

## Student workflow

The public Food page shows the current operational state, temporary hours, provider note and unavailable menu items. Only available items can be selected for a new request.

After a provider accepts a pickup, the student can open one active support case for that request. Categories cover late pickup, missing or incorrect items, quality, pickup problems and other issues. After confirmed collection, the student can submit one rating from 1–5 with an optional comment. Both actions require the authenticated student who owns the preorder.

## Staff workflow

The staff Food workspace contains:

- a default-off global pilot switch and published support contact;
- provider-level pilot admission;
- fulfilment metrics by provider;
- active pickup support cases;
- review, resolve and dismiss actions; and
- recent operational audit events.

Support resolution records the responsible staff account and outcome. Resolution sends the student a status notice. M3 support does not change order totals or create a financial promise.

## Data and authorization

Migration: sql/041_food_operations_pilot.sql

Core records:

- food_pilot_settings
- food_provider_operations
- food_operation_audit
- food_order_issues
- food_order_feedback

Vendor updates are scoped through the signed VENDOR console account and its single linked provider. Staff pilot and case actions require ADMIN or MODERATOR. Student care actions require a verified student session and preorder ownership. Mutation routes enforce same-origin requests and bounded rate limits where public traffic is expected.

## Pilot acceptance checklist

- Add and verify one real provider.
- Approve and link its named vendor account.
- Publish a support contact monitored during every pilot hour.
- Set a small daily request limit and practical response window.
- Admit only that provider, then enable the global gate.
- Test open, busy, closed and unavailable-item changes on mobile.
- Complete one request through collection.
- Open and resolve one test support case.
- Confirm the audit actor and timestamps.
- Review expired, declined, completed, response-time and rating metrics.
- Keep payment and delivery disabled until settlement, reconciliation, cancellation and refund rules are separately implemented and tested.
