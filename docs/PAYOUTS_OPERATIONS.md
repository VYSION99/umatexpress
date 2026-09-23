# Payouts — the Money Path, and Why a Payout Does Not Fire

**Status:** implemented — the ledger accrues, one gate decides who may be paid, and the settled Paystack balance is the ceiling
**Applies to:** `organizer_payouts`, `organizer_payout_batches`, the payouts console, `runPayoutReleaseJob`, `previewPayoutRun`

---

## 1. The path, in one reading

A fare becomes a payout in six steps, and each one has exactly one owner so a
payout can be explained without reading the code.

1. **Collection.** The passenger pays. Paystack keeps its percentage at checkout
   and the platform never holds it.
2. **Accrual.** `accrueForBooking` writes one ledger row: gross, commission, net.
   Amounts are append-only — a release changes `status`, never the numbers.
3. **The release window.** `release_after` is the moment the net becomes
   payable. It is the platform's reversal window, not the rail's; Paystack
   transfers to mobile money arrive in seconds. The value is written onto the
   row when it is created, so changing the setting never re-times money already
   earned.
4. **The gates.** One function, `eligibilityBlock`, decides whether this
   organizer may be paid at all: approved, KYC verified, a destination that is
   on a rail the platform pays, above the fee, above the minimum, and not an
   implausible pile of entries. Skipped organizers are reported with the reason.
5. **The balance.** Paystack settles each collection to the nominated account on
   its own schedule, so **the Paystack balance at that moment is the ceiling**,
   not the sum of what has been collected. A run spends it oldest earnings
   first and stops when it runs out.
6. **The transfer, then the ledger.** A batch is claimed, Paystack is addressed,
   and an entry becomes `RELEASED` only when Paystack says the money arrived. A
   failure returns the entries and the reason; it never loses them.

The one rule that ties it together: **money is only released once Paystack says
it arrived.** In flight is not released, so nothing is ever paid twice.

## 2. The three places a payout stops

A payout that does not fire is in one of three states, and they have different
answers. The readiness panel on **Console → Payouts** separates them, and the
preview below names each organizer's state.

| State | What it means | What to do |
| --- | --- | --- |
| **Blocked** | A gate refused it. The balance is irrelevant. | Fix the gate — the reason names it. |
| **Waiting on balance** | Every gate passed; there was nothing left to send from. | Fund the balance, or move to splits. |
| **Held back** | The run never considered them: a standing debt, or a transfer already in flight. | Clear the debt, or let the transfer settle. |

### Why each gate refuses, in words

- **NOT_APPROVED / KYC_NOT_VERIFIED** — the money gate. A person decided this
  organizer may not be paid; verify or reject from the same desk so the decision
  is recorded where the blocker is.
- **NO_DESTINATION** — no payout account, or no network/bank code, so a transfer
  cannot be addressed. The organizer has to save the details.
- **UNSUPPORTED_DESTINATION** — a bank account saved before rides moved to mobile
  money only. A bank transfer costs eight times the mobile money fee and the
  payout carries it, so it is refused rather than quietly paid at a loss. Ask
  for a mobile money account.
- **BELOW_FEE** — the payout would not survive its own transfer fee. Unreachable
  behind the minimum floor, and kept because the floor is a setting someone can
  turn to zero.
- **BELOW_MINIMUM** — under the payout minimum (default GHS 50.00). The entry
  stays on the ledger and joins the next payout, so the payee is paid less often
  but keeps more. A batch recorded by hand is never held back by this.
- **TOO_MANY_ENTRIES** — more entries than one batch should carry. That is a
  backlog nobody looked at, not a single day's earnings.
- **BALANCE_UNAVAILABLE** — the Paystack balance could not be read. The job skips
  rather than guesses: a transfer against an unknown balance is a guess.
- **INSUFFICIENT_BALANCE** — the settled balance cannot cover them. See §3; this
  is the one to look at first when nothing is being sent.
- **CLAIMED_BY_ANOTHER_RUN** — a concurrent run took the rows first. Nothing was
  sent, no attempt was burned, and the money is still owed.
- **NOTHING_DUE / NO_ORGANIZER** — a data fact, not a payment: the entry has no
  amount, or no organizer to attribute it to.

### Held back before the gate

Two conditions keep an organizer out of the candidate list entirely, and they
are reported separately because "not in the list" is otherwise indistinguishable
from "nothing owed":

- **DEBT_STANDING** — a reversed booking whose money had already left. The
  reversal creates a debt that blocks the next batch: paying out while a debt
  stands is paying money the platform has already given back.
- **TRANSFER_IN_FLIGHT** — a batch is already `PENDING` with Paystack. Sending
  again would double-pay.

## 3. When the balance is the reason

If the due total is above zero and the settled balance is zero, nothing is wrong
with the ledger, the organizers or the gates — the payout is looking in an empty
account. Paystack settles each collection to the account nominated in the
Paystack dashboard. When that account is the bank, **the money is out of Paystack
by the time a payout is due**.

Three fixes, in order of how much they cost to run:

1. **Keep the float in Paystack.** Point settlement at the Paystack balance
   rather than straight to the bank, and withdraw what the platform keeps. The
   balance then covers payouts and the run stops skipping.
2. **Top the balance up before a run.** The blunt version of the same fix: send
   in what is due, then run. The panel prints the exact figure.
3. **Settle through Paystack splits or subaccounts.** The durable fix: each
   collection leaves the organizer's share behind, so the money never has to be
   gathered again.

Unattended runs are a separate switch. Turning them off keeps the ledger and
every statement working while it is off, and the forecast is the same either way.

## 4. The preview

The release job reports why it skipped someone only after it has run, which is
no use to the person answering "why has this organizer not been paid?". The
payouts desk therefore carries a forecast, `previewPayoutRun`, returned with the
overview so the panel is right on load.

It walks the **same candidates through the same gates in the same order** as the
job — the gates live in one function, `eligibilityBlock`, precisely so the two
cannot drift — and stops short of every side effect:

- no recipient is created (creating one is a Paystack write),
- no batch row is written, and nothing is claimed,
- no transfer is addressed.

The one thing it adds is the distinction the job cannot make in advance: a
payout blocked by a gate, and one that is merely waiting on the balance. A test
holds the forecast and the run to the same refusal reason for the same
organizer, so a change to either is caught.

A run addresses only a handful of organizers at a time, so a long queue clears
over several runs, oldest earnings first. The schedule stops at
`MAX_RELEASE_CANDIDATES` (four), which keeps an unattended run well inside the
invocation's subrequest budget. **Run payouts now** is attended, and reaches
`MAX_ATTENDED_RELEASE_CANDIDATES` (six), because someone is watching the result
and can be told what happened.

## 5. Invariants

- Money is released only when Paystack confirms arrival; in flight is not
  released.
- The settled Paystack balance is the ceiling, not the sum collected.
- A gate that refuses says which gate, in a sentence, to the person who asked.
- The forecast changes nothing: reading the plan is never a payment.
- A reversal of money already sent creates a debt, and a debt blocks the next
  batch rather than being netted off quietly.
