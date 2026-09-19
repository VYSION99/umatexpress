# Console Assistant

**Status:** Phase 2 implemented (daily brief, read tools, confirmed actions, in-shell UI)
**Applies to:** every console service and every console role

---

## 1. What it is

One assistant for the whole console, the way there is one shell for the whole
console. It sits on every console page (`components/console/ConsoleAssistant.tsx`,
mounted by `ConsoleShell`), knows which service the person is looking at, and
does two things well:

* **answers from data** — "how many organizer applications are pending", "what
  is my queue like", "which trips are waiting for review" — by calling tools
  that run the same library functions the console pages use;
* **proposes actions** — "approve this application", "resolve that dispute" —
  which the person confirms on screen before anything changes.

It never invents numbers, never sees a password or PIN, and never changes data
on its own.

## 2. The daily brief

Opening the assistant shows the **daily brief** before the conversation starts:
a greeting, one line saying how many things need a decision, and a short list
of what is waiting — each row carrying the number, the name of the thing and
the console page that handles it. A badge on the Assistant button shows the
same count without opening the panel, so signing in at `/console` answers
"what needs me today" at a glance.

The console home carries the same brief as a compact strip above the service
directory (`components/console/ConsoleBriefStrip.tsx`): the summary, up to five
linked chips with attention items first, and a button that opens the assistant
panel. It renders nothing while it loads or when it cannot be read, so the
directory is never delayed by it.

The brief is composed by `consoleBriefFor()` in `lib/console-assistant.ts`
from the same library reads the console pages use, and is served by
`GET /api/console/assistant/brief` (60 reads / 10 minutes per caller). It never
calls a model, so the card on screen and the assistant's `daily_brief` tool
hold identical numbers.

What each role is shown:

| Role | The brief reads |
|------|-----------------|
| ADMIN | pending organizer applications, the trip review queue, open disputes, cleared payout balances, live CampusRide rides |
| MODERATOR | pending organizer applications, the trip review queue, open disputes |
| ORGANIZER | trips rejected or suspended (with the review reason), drafts, trips in review, the next departure, trips with open seats, ready earnings, disputes about their trips |
| DRIVER | a required password change, the current ride, the boarding queue with the next passenger, preview-mode data |

A section that cannot be read is named in the brief's note instead of failing
the whole card, and a role never sees another role's data: every read takes the
id from the signed session, exactly as the panel tools do.

## 3. Two rules that make it safe

1. **The role decides what exists.** The tool list sent to the model is built
   from the signed session's role, and the confirm endpoint re-reads the role
   before executing anything. A tool call inside a model response is a
   proposal, not an authority.
2. **A read happens now; a write waits for the person.** When the model calls
   an action tool, the server does **not** execute it. It signs the proposal
   (HMAC over `CONSOLE_SESSION_SECRET`, bound to the account id, 15-minute
   expiry) and returns it with a summary. The person sees the same title and
   the same arguments in a confirmation card, and pressing Confirm is the only
   path that runs it.

Tool results are treated as data, never instructions: a passenger name or a
dispute note that says "ignore your rules" is text inside a result.

## 4. The catalogue

`lib/console-assistant-catalog.ts` is the single description of what the
assistant may know and do. Each tool declares:

| Field | Meaning |
|-------|---------|
| `name` | Model-safe function name (`organizers_list`) |
| `kind` | `read` runs immediately; `action` becomes a confirmation |
| `roles` | The console roles that may use it |
| `description` | What the model reads to choose the tool; write it for the model |
| `parameters` | Typed, documented arguments; an `Id` argument is always required |

The runtime in `lib/console-assistant.ts` maps each name to a handler. Handlers
either call an existing library function with the account's own id (an
organizer's trips, a driver's shift) or pass the original request to a
request-scoped function (`campusOverview`, `driverMe`, `driverQueue`), so the
assistant inherits exactly the permissions the page would have had.

### Adding a tool

1. Add the entry to `consoleAssistantTools` with the narrowest role list that
   makes sense. An `action` tool must say what it acts on.
2. Add the handler to `handlers` in `lib/console-assistant.ts`. Read tools
   return a **summary** (cap lists at ~15 rows), not a raw table.
3. If the underlying function audits, the assistant inherits the audit. If it
   does not, audit in the handler.
4. Run `node --test tests/console-assistant.test.mjs`. The tests pin that no
   role can reach a tool it does not hold, that a signed proposal cannot be
   replayed by another account, and that an action proposal cannot be executed
   by a role that does not hold the tool.

## 5. The model

The assistant runs on Workers AI through the same binding as the rest of the
AI surfaces (`env.AI`). It prefers `CONSOLE_ASSISTANT_MODEL` and falls back to
`CLOUDFLARE_AI_MODEL`; the default is
`@cf/meta/llama-3.3-70b-instruct-fp8-fast`, chosen because tool calling and
short factual answers are what this feature needs.

The loop: up to 4 model steps, at most 3 tool calls per step, tool results
clipped at 4,000 characters, replies clipped at 4,000 characters and asked for
in under 90 words. If the model answers without a tool, that text is returned
as-is; if it proposes an action, the loop stops there.

## 6. Limits and privacy

| Limit | Value |
|-------|-------|
| Conversations | 30 requests / 10 minutes per caller |
| Confirmations | 20 / 10 minutes per caller |
| Proposal lifetime | 15 minutes, bound to the account that proposed it |

The assistant can read only what the role's own pages read: passenger contact
details stay behind the audited staff surfaces (decision D3), drivers never see
boarding PINs, and an organizer only ever reaches their own rows — every
handler takes the id from the session, never from the model.

## 7. Verification

| Check | Command |
|-------|---------|
| Catalogue, role scoping, proposal signing | `node --test tests/console-assistant.test.mjs` |
| The daily brief's shape and role bounds | `node --test tests/console-assistant.test.mjs` |
| The brief card and the assistant in the shell (stubbed model) | `node scripts/check-console-origin.mjs` |
| Types and lint | `npm run typecheck`, `npm run lint` |

The browser check stubs the assistant endpoints, so it verifies the brief
card and badge, the panel, the tool chips, the confirmation card and the
confirm round-trip without calling a model.
