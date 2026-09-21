"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { BadgeCheck, Bell, Check, Loader2, MessageSquare, Phone, Plus, Send, UserX, Wallet, X } from "lucide-react";
import type { ConsoleSessionInfo } from "@/components/admin/ConsoleSessionGate";
import { cedis } from "@/components/campusRide/hostel/format";
import { subscribeToHostelThread } from "@/components/campusRide/hostel/message-stream-client";

type Booking = {
  id: string; reference: string; studentName: string; studentEmail: string; studentPhone: string;
  propertyName: string; roomLabel: string; spaceLabel: string; periodName: string;
  totalAmount: number; netAmount: number; commissionAmount: number;
  status: string; paidAt: string; createdAt: string; holdExpiresAt: string;
};

type Resident = Booking & { unreadMessages: number; openServices: number };

type Summary = {
  total: number; resident: number; awaitingPayment: number; needsReview: number;
  unreadMessages: number; openServices: number;
  bedRevenue: number; commission: number; net: number;
};

type ServiceRequest = {
  id: string; bookingId: string; pluginId: string; pluginName: string; pluginCategory: string;
  studentName: string; studentEmail: string; price: number; note: string;
  status: string; decidedBy: string; decidedAt: string; createdAt: string;
};

type Plugin = {
  id: string; code: string; name: string; description: string; category: string;
  price: number; suggestedResidentPrice: number; active: boolean;
};

type Subscription = {
  id: string; pluginId: string; pluginName: string; pluginCategory: string;
  periodId: string; periodName: string; propertyId: string;
  platformPrice: number; residentPrice: number; status: string; reference: string; holdExpiresAt: string;
};

type Manager = { id: string; name: string; email: string; phone: string; status: string; createdAt: string };
type Announcement = { id: string; propertyName: string; authorName: string; title: string; body: string; createdAt: string };
type Message = { id: string; senderType: string; senderName: string; content: string; createdAt: string };
type Period = { id: string; name: string };
type Property = { id: string; name: string };
type PayoutDestination = { code: string; name: string };
type Destinations = { BANK: PayoutDestination[]; MOMO: PayoutDestination[] };
type PayoutAccount = {
  method: string; accountName: string; accountMasked: string; last4: string;
  bankCode: string; bankName: string; updatedAt: string; ready: boolean;
};
type PayoutEntry = {
  id: string; bookingReference: string; propertyName: string; studentName: string; periodName: string;
  grossAmount: number; commissionAmount: number; netAmount: number;
  status: string; releaseAfter: string; releasedAt: string; transferReference: string; createdAt: string;
};
type PayoutBatch = {
  id: string; totalAmount: number; transferFee?: number; entryCount: number; transferReference: string; note: string; createdBy: string; createdAt: string;
};

/** What reached the landlord: the ledger amount less the rail's fee. */
function received(batch: PayoutBatch) {
  return Math.max(0, Number(batch.totalAmount || 0) - Number(batch.transferFee || 0));
}
type PayoutStatement = {
  entries: PayoutEntry[];
  batches: PayoutBatch[];
  totals: { accruedAmount: number; payableAmount: number; releasedAmount: number };
};

type Tab = "residents" | "requests" | "services" | "payouts" | "team" | "notices";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "residents", label: "Residents" },
  { id: "requests", label: "Service requests" },
  { id: "services", label: "Services & fees" },
  { id: "payouts", label: "Money & payouts" },
  { id: "team", label: "Team" },
  { id: "notices", label: "Notices" },
];

const EMPTY_DESTINATIONS: Destinations = { BANK: [], MOMO: [] };

/** What the host may do next with a request, and nothing else. */
const SERVICE_ACTIONS: Record<string, Array<{ action: string; label: string }>> = {
  REQUESTED: [{ action: "APPROVE", label: "Approve" }, { action: "DECLINE", label: "Decline" }],
  APPROVED: [{ action: "START", label: "Start" }, { action: "CANCEL", label: "Cancel" }],
  ACTIVE: [{ action: "COMPLETE", label: "Complete" }, { action: "CANCEL", label: "Cancel" }],
};

const statusLabel: Record<string, string> = {
  PENDING_PAYMENT: "Holding",
  PAID: "Resident",
  PAYMENT_REVIEW: "Under review",
  EXPIRED: "Expired",
  CANCELLED: "Cancelled",
  REFUNDED: "Refunded",
  REQUESTED: "Asked",
  APPROVED: "Approved",
  DECLINED: "Declined",
  ACTIVE: "Running",
  COMPLETED: "Done",
  REVOKED: "Revoked",
};

const when = (iso: string) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");

/**
 * The landlord's resident workspace: who has paid for a bed, what they have
 * asked for on top of it, the services the hostel has switched on, and the
 * people the owner has trusted to help run it.
 *
 * A delegate manager sees the same rows as the owner; only appointing and
 * revoking a manager is refused, which the server enforces rather than this
 * screen.
 */
export function ResidentWorkspace({ session }: { session: ConsoleSessionInfo }) {
  const [tab, setTab] = useState<Tab>("residents");
  const [residents, setResidents] = useState<Resident[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [requests, setRequests] = useState<ServiceRequest[]>([]);
  const [catalogue, setCatalogue] = useState<Plugin[]>([]);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [managers, setManagers] = useState<Manager[]>([]);
  const [ownerAccess, setOwnerAccess] = useState(false);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [periods, setPeriods] = useState<Period[]>([]);
  const [properties, setProperties] = useState<Property[]>([]);
  const [payoutAccount, setPayoutAccount] = useState<PayoutAccount | null>(null);
  const [payoutStatement, setPayoutStatement] = useState<PayoutStatement | null>(null);
  const [destinations, setDestinations] = useState<Destinations>(EMPTY_DESTINATIONS);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [thread, setThread] = useState<{ reference: string; name: string } | null>(null);

  const loadResidents = useCallback(async () => {
    const response = await fetch("/api/console/hostel/residents", { credentials: "same-origin", cache: "no-store" });
    const data = await response.json() as { residents?: Resident[]; summary?: Summary; isOwner?: boolean; error?: string };
    if (!response.ok) throw new Error(data.error || "The residents could not be loaded.");
    setResidents(data.residents || []);
    setSummary(data.summary || null);
    setOwnerAccess(Boolean(data.isOwner));
  }, []);

  const loadRequests = useCallback(async () => {
    const response = await fetch("/api/console/hostel/services", { credentials: "same-origin", cache: "no-store" });
    const data = await response.json() as { requests?: ServiceRequest[]; error?: string };
    if (!response.ok) throw new Error(data.error || "The service requests could not be loaded.");
    setRequests(data.requests || []);
  }, []);

  const loadServices = useCallback(async () => {
    const response = await fetch("/api/console/hostel/plugins", { credentials: "same-origin", cache: "no-store" });
    const data = await response.json() as { catalogue?: Plugin[]; subscriptions?: Subscription[]; error?: string };
    if (!response.ok) throw new Error(data.error || "The services could not be loaded.");
    setCatalogue(data.catalogue || []);
    setSubscriptions(data.subscriptions || []);
  }, []);

  const loadTeam = useCallback(async () => {
    const response = await fetch("/api/console/hostel/managers", { credentials: "same-origin", cache: "no-store" });
    const data = await response.json() as { managers?: Manager[]; isOwner?: boolean; error?: string };
    if (!response.ok) throw new Error(data.error || "The team could not be loaded.");
    setManagers(data.managers || []);
    setOwnerAccess(Boolean(data.isOwner));
  }, []);

  const loadNotices = useCallback(async () => {
    const response = await fetch("/api/console/hostel/announcements", { credentials: "same-origin", cache: "no-store" });
    const data = await response.json() as { announcements?: Announcement[]; error?: string };
    if (!response.ok) throw new Error(data.error || "The notices could not be loaded.");
    setAnnouncements(data.announcements || []);
  }, []);

  const loadFilters = useCallback(async () => {
    const [periodResponse, propertyResponse] = await Promise.all([
      fetch("/api/hostel/periods", { cache: "no-store" }),
      fetch("/api/console/hostel/properties", { credentials: "same-origin", cache: "no-store" }),
    ]);
    const periodData = await periodResponse.json() as { periods?: Period[] };
    const propertyData = await propertyResponse.json() as { properties?: Property[] };
    setPeriods(periodData.periods || []);
    setProperties(propertyData.properties || []);
  }, []);

  /** The money tab reads both halves: where it goes, and what has accrued. */
  const loadPayouts = useCallback(async () => {
    const [accountResponse, statementResponse] = await Promise.all([
      fetch("/api/console/hostel/payout-account", { credentials: "same-origin", cache: "no-store" }),
      fetch("/api/console/hostel/statement", { credentials: "same-origin", cache: "no-store" }),
    ]);
    const accountData = await accountResponse.json() as { account?: PayoutAccount; destinations?: Destinations; error?: string };
    if (!accountResponse.ok) throw new Error(accountData.error || "The payout account could not be loaded.");
    setPayoutAccount(accountData.account || null);
    setDestinations(accountData.destinations || EMPTY_DESTINATIONS);
    const statementData = await statementResponse.json() as PayoutStatement & { error?: string };
    if (!statementResponse.ok) throw new Error(statementData.error || "The statement could not be loaded.");
    setPayoutStatement({ entries: statementData.entries || [], batches: statementData.batches || [], totals: statementData.totals });
  }, []);

  const run = useCallback(async (task: () => Promise<void>) => {
    setError("");
    try {
      await task();
    } catch (taskError) {
      setError(taskError instanceof Error ? taskError.message : "That did not work.");
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void run(loadResidents);
      void loadFilters().catch(() => undefined);
    });
  }, [loadFilters, loadResidents, run]);

  useEffect(() => {
    queueMicrotask(() => {
      if (tab === "requests") void run(loadRequests);
      if (tab === "services") void run(loadServices);
      if (tab === "payouts") void run(loadPayouts);
      if (tab === "team") void run(loadTeam);
      if (tab === "notices") void run(loadNotices);
    });
  }, [tab, loadNotices, loadPayouts, loadRequests, loadServices, loadTeam, run]);

  // Paystack sends the landlord back with the reference in the query string;
  // settling it here means the fee is confirmed without a second click.
  useEffect(() => {
    const reference = new URLSearchParams(window.location.search).get("plugin");
    if (!reference) return;
    window.history.replaceState({}, "", window.location.pathname);
    queueMicrotask(() => {
      void (async () => {
        setBusy("verify-plugin");
        try {
          const response = await fetch(`/api/console/hostel/plugins/verify?reference=${encodeURIComponent(reference)}`, { credentials: "same-origin", cache: "no-store" });
          const data = await response.json() as { subscription?: Subscription; error?: string };
          if (!response.ok) throw new Error(data.error || "That payment could not be confirmed.");
          setNotice(`${data.subscription?.pluginName || "Service"} is now switched on.`);
          setTab("services");
          await loadServices();
        } catch (verifyError) {
          setError(verifyError instanceof Error ? verifyError.message : "That payment could not be confirmed.");
        } finally {
          setBusy("");
        }
      })();
    });
  }, [loadServices]);

  return <>
    {summary && <section className="console-totals">
      <article><span>RESIDENTS</span><strong>{summary.resident}</strong><small>{summary.total} bookings on record</small></article>
      <article><span>BED MONEY</span><strong>{cedis(summary.bedRevenue)}</strong><small>paid this year</small></article>
      <article><span>PLATFORM 3%</span><strong>{cedis(summary.commission)}</strong><small>your net is {cedis(summary.net)}</small></article>
      <article><span>NEEDS YOU</span><strong>{summary.openServices}</strong><small>{summary.unreadMessages} unread messages</small></article>
    </section>}

    <section className="console-panel">
      <h2><Wallet size={18} aria-hidden />Residents &amp; services</h2>
      <div className="console-toolbar">
        {TABS.map((entry) => <button
          key={entry.id}
          type="button"
          className={entry.id === tab ? "is-active" : ""}
          onClick={() => { setNotice(""); setError(""); setTab(entry.id); }}
        >{entry.label}</button>)}
      </div>

      {error && <div className="console-alert" role="alert">{error}</div>}
      {notice && !error && <div className="console-alert console-alert-ok" role="status">{notice}</div>}

      {tab === "residents" && <ResidentsTable
        residents={residents}
        busy={busy}
        onThread={(resident) => setThread({ reference: resident.reference, name: resident.studentName || resident.studentEmail })}
      />}

      {tab === "requests" && <RequestsTable
        requests={requests}
        busy={busy}
        onDecide={(request, action) => run(async () => {
          setBusy(`service:${request.id}`);
          try {
            const response = await fetch("/api/console/hostel/services", {
              method: "PATCH",
              credentials: "same-origin",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ requestId: request.id, action }),
            });
            const data = await response.json() as { error?: string };
            if (!response.ok) throw new Error(data.error || "That decision did not go through.");
            setNotice(`${request.pluginName} · ${statusLabel[action === "APPROVE" ? "APPROVED" : action === "DECLINE" ? "DECLINED" : action === "START" ? "ACTIVE" : action === "COMPLETE" ? "COMPLETED" : "CANCELLED"]}`);
            await loadRequests();
            await loadResidents();
          } finally {
            setBusy("");
          }
        })}
      />}

      {tab === "services" && <ServicesPanel
        catalogue={catalogue}
        subscriptions={subscriptions}
        periods={periods}
        properties={properties}
        busy={busy}
        onSubscribe={(input) => run(async () => {
          setBusy("subscribe");
          try {
            const response = await fetch("/api/console/hostel/plugins", {
              method: "POST",
              credentials: "same-origin",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(input),
            });
            const data = await response.json() as { authorizationUrl?: string; error?: string };
            if (!response.ok) throw new Error(data.error || "That service could not be switched on.");
            if (data.authorizationUrl) window.location.assign(data.authorizationUrl);
            else { setNotice("That service is already active."); await loadServices(); }
          } finally {
            setBusy("");
          }
        })}
        onCancel={(subscription) => run(async () => {
          setBusy(`cancel:${subscription.reference}`);
          try {
            const response = await fetch(`/api/console/hostel/plugins/${encodeURIComponent(subscription.reference)}`, { method: "DELETE", credentials: "same-origin" });
            const data = await response.json() as { error?: string };
            if (!response.ok) throw new Error(data.error || "That window could not be closed.");
            setNotice("The unpaid window is closed. Start it again whenever you are ready.");
            await loadServices();
          } finally {
            setBusy("");
          }
        })}
      />}

      {tab === "payouts" && <PayoutsPanel
        account={payoutAccount}
        statement={payoutStatement}
        destinations={destinations}
        isOwner={ownerAccess}
        busy={busy}
        onSaveAccount={(input) => run(async () => {
          setBusy("payout-account");
          try {
            const response = await fetch("/api/console/hostel/payout-account", {
              method: "POST",
              credentials: "same-origin",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(input),
            });
            const data = await response.json() as { account?: PayoutAccount; error?: string };
            if (!response.ok) throw new Error(data.error || "That payout account could not be saved.");
            setPayoutAccount(data.account || null);
            setNotice("Payout account saved. Money goes to the account ending " + (data.account?.last4 || "") + ".");
            await loadPayouts();
          } finally {
            setBusy("");
          }
        })}
      />}

      {tab === "team" && <TeamPanel
        managers={managers}
        isOwner={ownerAccess}
        ownerEmail={session.account.email}
        busy={busy}
        onInvite={(input) => run(async () => {
          setBusy("invite");
          try {
            const response = await fetch("/api/console/hostel/managers", {
              method: "POST",
              credentials: "same-origin",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(input),
            });
            const data = await response.json() as { manager?: Manager; error?: string };
            if (!response.ok) throw new Error(data.error || "That manager could not be added.");
            setNotice(`${data.manager?.name || "The manager"} can now sign in on this console with their own email.`);
            await loadTeam();
          } finally {
            setBusy("");
          }
        })}
        onRevoke={(manager) => run(async () => {
          setBusy(`revoke:${manager.id}`);
          try {
            const response = await fetch(`/api/console/hostel/managers/${encodeURIComponent(manager.id)}`, { method: "DELETE", credentials: "same-origin" });
            const data = await response.json() as { error?: string };
            if (!response.ok) throw new Error(data.error || "That manager could not be removed.");
            setNotice(`${manager.name || manager.email} no longer has access.`);
            await loadTeam();
          } finally {
            setBusy("");
          }
        })}
      />}

      {tab === "notices" && <NoticesPanel
        announcements={announcements}
        properties={properties}
        busy={busy}
        onPublish={(input) => run(async () => {
          setBusy("notice");
          try {
            const response = await fetch("/api/console/hostel/announcements", {
              method: "POST",
              credentials: "same-origin",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(input),
            });
            const data = await response.json() as { error?: string };
            if (!response.ok) throw new Error(data.error || "That notice could not be published.");
            setNotice("Published. Every resident of that property sees it on their page.");
            await loadNotices();
          } finally {
            setBusy("");
          }
        })}
      />}

      <p className="console-note">
        Bed payments are shown with the platform&apos;s 3% commission already taken out. Service fees are charged once per
        academic year per plugin, on top of that commission, and the price a resident pays for each service is yours to set.
      </p>
    </section>

    {thread && <ThreadPanel
      reference={thread.reference}
      name={thread.name}
      onClose={() => setThread(null)}
    />}
  </>;
}

function ResidentsTable({ residents, busy, onThread }: {
  residents: Resident[];
  busy: string;
  onThread: (resident: Resident) => void;
}) {
  if (!residents.length) return <p className="console-empty">No student has booked a bed yet. Approved beds appear on the student map straight away.</p>;
  return <table className="console-table">
    <thead><tr><th>Resident</th><th>Bed</th><th>Paid</th><th>Status</th><th>Needs you</th><th></th></tr></thead>
    <tbody>
      {residents.map((resident) => <tr key={resident.id}>
        <td><strong>{resident.studentName || "Student"}</strong><small>{resident.studentEmail}{resident.studentPhone ? ` · ${resident.studentPhone}` : ""}</small></td>
        <td><span>{resident.propertyName}</span><small>{resident.roomLabel}{resident.spaceLabel ? ` · ${resident.spaceLabel}` : ""} · {resident.periodName}</small></td>
        <td><span>{cedis(resident.totalAmount)}</span><small>net {cedis(resident.netAmount)}</small></td>
        <td><span className={`console-badge console-badge-${resident.status.toLowerCase().replace("_", "")}`}>{statusLabel[resident.status] || resident.status}</span></td>
        <td><span>{resident.unreadMessages} unread</span><small>{resident.openServices} open service{resident.openServices === 1 ? "" : "s"}</small></td>
        <td className="console-row-actions">
          <button type="button" disabled={busy === resident.id} onClick={() => onThread(resident)}><MessageSquare size={15} aria-hidden />Message</button>
        </td>
      </tr>)}
    </tbody>
  </table>;
}

function RequestsTable({ requests, busy, onDecide }: {
  requests: ServiceRequest[];
  busy: string;
  onDecide: (request: ServiceRequest, action: string) => void;
}) {
  if (!requests.length) return <p className="console-empty">No resident has asked for a service yet.</p>;
  return <table className="console-table">
    <thead><tr><th>Service</th><th>Resident</th><th>Price</th><th>Status</th><th>Asked</th><th></th></tr></thead>
    <tbody>
      {requests.map((request) => <tr key={request.id}>
        <td><strong>{request.pluginName}</strong><small>{request.note || request.pluginCategory.toLowerCase()}</small></td>
        <td><span>{request.studentName || "Student"}</span><small>{request.studentEmail}</small></td>
        <td>{cedis(request.price)}</td>
        <td><span className={`console-badge console-badge-${request.status.toLowerCase()}`}>{statusLabel[request.status] || request.status}</span></td>
        <td><span>{when(request.createdAt)}</span><small>{request.decidedBy ? `by ${request.decidedBy}` : ""}</small></td>
        <td className="console-row-actions">
          {(SERVICE_ACTIONS[request.status] || []).map((entry) => <button
            key={entry.action}
            type="button"
            disabled={busy === `service:${request.id}`}
            onClick={() => onDecide(request, entry.action)}
          >
            {entry.action === "APPROVE" || entry.action === "COMPLETE" ? <Check size={15} aria-hidden /> : <X size={15} aria-hidden />}
            {entry.label}
          </button>)}
        </td>
      </tr>)}
    </tbody>
  </table>;
}

function ServicesPanel({ catalogue, subscriptions, periods, properties, busy, onSubscribe, onCancel }: {
  catalogue: Plugin[];
  subscriptions: Subscription[];
  periods: Period[];
  properties: Property[];
  busy: string;
  onSubscribe: (input: { pluginId: string; periodId: string; propertyId: string; residentPrice: number }) => void;
  onCancel: (subscription: Subscription) => void;
}) {
  const [form, setForm] = useState({ pluginId: "", periodId: "", propertyId: "", residentPrice: "" });
  const chosen = catalogue.find((plugin) => plugin.id === form.pluginId);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!form.pluginId || !form.periodId) return;
    onSubscribe({
      pluginId: form.pluginId,
      periodId: form.periodId,
      propertyId: form.propertyId,
      residentPrice: form.residentPrice === "" ? (chosen?.suggestedResidentPrice ?? 0) : Math.round(Number(form.residentPrice) * 100),
    });
  };

  const active = subscriptions.filter((entry) => entry.status === "ACTIVE");
  const pending = subscriptions.filter((entry) => entry.status === "PENDING_PAYMENT");

  return <>
    <form className="console-form" onSubmit={submit}>
      <label>Service
        <select value={form.pluginId} onChange={(event) => {
          const plugin = catalogue.find((entry) => entry.id === event.target.value);
          setForm({ ...form, pluginId: event.target.value, residentPrice: plugin ? (plugin.suggestedResidentPrice / 100).toFixed(2) : "" });
        }}>
          <option value="">Choose a service…</option>
          {catalogue.map((plugin) => <option key={plugin.id} value={plugin.id}>{plugin.name} · {cedis(plugin.price)} a year</option>)}
        </select>
      </label>
      <label>Academic year
        <select value={form.periodId} onChange={(event) => setForm({ ...form, periodId: event.target.value })}>
          <option value="">Choose a year…</option>
          {periods.map((period) => <option key={period.id} value={period.id}>{period.name}</option>)}
        </select>
      </label>
      <label>Property
        <select value={form.propertyId} onChange={(event) => setForm({ ...form, propertyId: event.target.value })}>
          <option value="">All my properties</option>
          {properties.map((property) => <option key={property.id} value={property.id}>{property.name}</option>)}
        </select>
      </label>
      <label>Resident pays (GH₵)
        <input type="text" inputMode="decimal" value={form.residentPrice} onChange={(event) => setForm({ ...form, residentPrice: event.target.value })} placeholder={chosen ? (chosen.suggestedResidentPrice / 100).toFixed(2) : "0.00"} />
      </label>
      <button type="submit" disabled={busy === "subscribe" || !form.pluginId || !form.periodId}>
        {busy === "subscribe" ? <Loader2 size={15} className="console-spin" aria-hidden /> : <Plus size={15} aria-hidden />}
        Pay {chosen ? cedis(chosen.price) : "the fee"} and switch on
      </button>
    </form>
    {chosen && <p className="console-note">{chosen.description} The platform fee is charged to you once a year; the price you set is what each resident pays you for it.</p>}

    <table className="console-table">
      <thead><tr><th>Service</th><th>Year</th><th>Scope</th><th>Platform fee</th><th>Resident pays</th><th>Status</th><th></th></tr></thead>
      <tbody>
        {[...pending, ...active].map((subscription) => <tr key={subscription.id}>
          <td><strong>{subscription.pluginName}</strong><small>{subscription.pluginCategory.toLowerCase()}</small></td>
          <td>{subscription.periodName}</td>
          <td>{properties.find((property) => property.id === subscription.propertyId)?.name || "All properties"}</td>
          <td>{cedis(subscription.platformPrice)}</td>
          <td>{subscription.residentPrice > 0 ? cedis(subscription.residentPrice) : "Included"}</td>
          <td><span className={`console-badge console-badge-${subscription.status.toLowerCase().replace("_", "")}`}>{statusLabel[subscription.status] || subscription.status}</span></td>
          <td className="console-row-actions">
            {subscription.status === "PENDING_PAYMENT" && <>
              <a className="console-inline-link" href={`/api/console/hostel/plugins/verify?reference=${encodeURIComponent(subscription.reference)}`}><BadgeCheck size={15} aria-hidden />I have paid</a>
              <button type="button" disabled={busy === `cancel:${subscription.reference}`} onClick={() => onCancel(subscription)}><X size={15} aria-hidden />Cancel</button>
            </>}
          </td>
        </tr>)}
      </tbody>
    </table>
    {!subscriptions.length && <p className="console-empty">No service is switched on yet. Each one is a once-a-year fee, separate from the 3% bed commission.</p>}
  </>;
}

function TeamPanel({ managers, isOwner, ownerEmail, busy, onInvite, onRevoke }: {
  managers: Manager[];
  isOwner: boolean;
  ownerEmail: string;
  busy: string;
  onInvite: (input: { name: string; email: string; phone: string; password: string }) => void;
  onRevoke: (manager: Manager) => void;
}) {
  const [form, setForm] = useState({ name: "", email: "", phone: "", password: "" });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onInvite(form);
  };

  return <>
    {isOwner
      ? <form className="console-form" onSubmit={submit}>
        <label>Name<input type="text" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Ama Mensah" /></label>
        <label>Email<input type="text" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} placeholder="ama@example.com" /></label>
        <label>Phone<input type="text" value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} placeholder="024 000 0000" /></label>
        <label>Console password<input type="text" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder="At least 10 characters" /></label>
        <button type="submit" disabled={busy === "invite" || !form.name || !form.email || !form.password}>
          {busy === "invite" ? <Loader2 size={15} className="console-spin" aria-hidden /> : <Plus size={15} aria-hidden />}
          Add manager
        </button>
      </form>
      : <p className="console-note">Only the account owner ({ownerEmail}) can add or remove managers. You can see who else runs these buildings.</p>}

    <table className="console-table">
      <thead><tr><th>Manager</th><th>Contact</th><th>Added</th><th>Status</th><th></th></tr></thead>
      <tbody>
        <tr>
          <td><strong>Owner account</strong><small>{ownerEmail}</small></td>
          <td>—</td>
          <td>—</td>
          <td><span className="console-badge console-badge-approved">Owner</span></td>
          <td />
        </tr>
        {managers.map((manager) => <tr key={manager.id}>
          <td><strong>{manager.name}</strong><small>{manager.email}</small></td>
          <td>{manager.phone ? <span><Phone size={13} aria-hidden /> {manager.phone}</span> : "—"}</td>
          <td>{when(manager.createdAt)}</td>
          <td><span className={`console-badge console-badge-${manager.status.toLowerCase() === "active" ? "approved" : "rejected"}`}>{statusLabel[manager.status] || manager.status}</span></td>
          <td className="console-row-actions">
            {isOwner && manager.status === "ACTIVE" && <button type="button" disabled={busy === `revoke:${manager.id}`} onClick={() => onRevoke(manager)}>
              <UserX size={15} aria-hidden />Remove
            </button>}
          </td>
        </tr>)}
      </tbody>
    </table>
  </>;
}

function NoticesPanel({ announcements, properties, busy, onPublish }: {
  announcements: Announcement[];
  properties: Property[];
  busy: string;
  onPublish: (input: { propertyId: string; title: string; body: string }) => void;
}) {
  const [form, setForm] = useState({ propertyId: "", title: "", body: "" });

  return <>
    <form className="console-form" onSubmit={(event) => { event.preventDefault(); onPublish(form); }}>
      <label>Property
        <select value={form.propertyId} onChange={(event) => setForm({ ...form, propertyId: event.target.value })}>
          <option value="">Every property</option>
          {properties.map((property) => <option key={property.id} value={property.id}>{property.name}</option>)}
        </select>
      </label>
      <label>Title<input type="text" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="Water tank cleaning on Saturday" /></label>
      <label className="console-field-wide">Message<textarea value={form.body} onChange={(event) => setForm({ ...form, body: event.target.value })} rows={3} placeholder="Say what happens, when, and what residents should do." /></label>
      <button type="submit" disabled={busy === "notice" || !form.title || !form.body}>
        {busy === "notice" ? <Loader2 size={15} className="console-spin" aria-hidden /> : <Bell size={15} aria-hidden />}
        Publish to residents
      </button>
    </form>
    {announcements.length === 0
      ? <p className="console-empty">No notices published yet.</p>
      : <table className="console-table">
        <thead><tr><th>Notice</th><th>Property</th><th>Written by</th><th>Published</th></tr></thead>
        <tbody>
          {announcements.map((announcement) => <tr key={announcement.id}>
            <td><strong>{announcement.title}</strong><small>{announcement.body}</small></td>
            <td>{announcement.propertyName || "Every property"}</td>
            <td>{announcement.authorName || "Hostel office"}</td>
            <td>{when(announcement.createdAt)}</td>
          </tr>)}
        </tbody>
      </table>}
  </>;
}

/**
 * The money tab: what the platform has earned for the landlord, what it is
 * still holding, what it has already sent, and the account a transfer would
 * reach. Only the owner may change the destination; a manager sees the same
 * statement without the pen.
 */
/**
 * The account form, keyed by the saved account so a successful save remounts it
 * with the new values instead of needing an effect to copy them in.
 */
function PayoutAccountForm({ account, destinations, busy, onSave }: {
  account: PayoutAccount | null;
  destinations: Destinations;
  busy: string;
  onSave: (input: { method: string; accountName: string; accountNumber: string; bankCode: string }) => void;
}) {
  const [form, setForm] = useState({
    method: account?.method || "MOMO",
    accountName: account?.accountName || "",
    accountNumber: "",
    bankCode: account?.bankCode || "",
  });
  const choices = destinations[form.method === "BANK" ? "BANK" : "MOMO"] || [];

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!form.accountName.trim() || !form.accountNumber.trim() || !form.bankCode) return;
    onSave(form);
  };

  return <form className="console-form" onSubmit={submit}>
    <label>Type
      <select value={form.method} onChange={(event) => setForm({ ...form, method: event.target.value, bankCode: "" })}>
        <option value="MOMO">Mobile money</option>
        <option value="BANK">Bank account</option>
      </select>
    </label>
    <label>Account name
      <input type="text" value={form.accountName} onChange={(event) => setForm({ ...form, accountName: event.target.value })} maxLength={80} placeholder="Name on the account" />
    </label>
    <label>{form.method === "BANK" ? "Bank" : "Network"}
      <select value={form.bankCode} onChange={(event) => setForm({ ...form, bankCode: event.target.value })}>
        <option value="">Choose…</option>
        {choices.map((choice) => <option key={choice.code} value={choice.code}>{choice.name}</option>)}
      </select>
    </label>
    <label>Account number
      <input type="text" value={form.accountNumber} onChange={(event) => setForm({ ...form, accountNumber: event.target.value })} maxLength={40} placeholder={account?.ready ? "Enter the number again to replace it" : "Account or mobile money number"} />
    </label>
    <button type="submit" disabled={busy === "payout-account" || !form.accountName.trim() || !form.accountNumber.trim() || !form.bankCode}>
      {busy === "payout-account" ? <Loader2 size={15} className="console-spin" aria-hidden /> : <Check size={15} aria-hidden />}
      Save account
    </button>
  </form>;
}

function PayoutsPanel({ account, statement, destinations, isOwner, busy, onSaveAccount }: {
  account: PayoutAccount | null;
  statement: PayoutStatement | null;
  destinations: Destinations;
  isOwner: boolean;
  busy: string;
  onSaveAccount: (input: { method: string; accountName: string; accountNumber: string; bankCode: string }) => void;
}) {
  const now = new Date().toISOString();

  return <>
    <section className="console-totals">
      <article><span>READY TO PAY</span><strong>{cedis(statement?.totals.payableAmount || 0)}</strong><small>released to you now</small></article>
      <article><span>STILL HELD</span><strong>{cedis(statement?.totals.accruedAmount || 0)}</strong><small>releases shortly before the year starts</small></article>
      <article><span>PAID OUT</span><strong>{cedis(statement?.totals.releasedAmount || 0)}</strong><small>{statement?.batches.length || 0} transfer{(statement?.batches.length || 0) === 1 ? "" : "s"} recorded</small></article>
      <article><span>PLATFORM</span><strong>3%</strong><small>kept from each bed payment</small></article>
    </section>

    <section className="console-panel">
      <h2><Wallet size={18} aria-hidden />Payout account</h2>
      <p className="console-note">
        {account?.ready
          ? <>Payouts are addressed to <strong>{account.accountName}</strong> · {account.bankName || account.method} {account.accountMasked}. </>
          : <>No payout account is saved yet, so no transfer can be recorded for you. </>}
        {isOwner ? "Enter a new number below to change it." : "Only the account owner can change this."}
      </p>
      {isOwner && <PayoutAccountForm
        key={`${account?.updatedAt || "new"}:${account?.last4 || ""}:${destinations.BANK.length}`}
        account={account}
        destinations={destinations}
        busy={busy}
        onSave={onSaveAccount}
      />}
    </section>

    <h3 className="console-subhead">Bed earnings</h3>
    {!statement
      ? <p className="console-empty"><Loader2 size={15} className="console-spin" aria-hidden /> Loading your statement…</p>
      : statement.entries.length === 0
        ? <p className="console-empty">No bed payment has landed yet. Each paid resident appears here with the platform&apos;s 3% already taken out.</p>
        : <table className="console-table">
          <thead><tr><th>Resident</th><th>Bed</th><th>Paid</th><th>Platform 3%</th><th>Your net</th><th>Release</th></tr></thead>
          <tbody>
            {statement.entries.map((entry) => <tr key={entry.id}>
              <td><strong>{entry.studentName || "Student"}</strong><small>{entry.bookingReference} · {entry.periodName}</small></td>
              <td>{entry.propertyName}</td>
              <td>{cedis(entry.grossAmount)}</td>
              <td>{cedis(entry.commissionAmount)}</td>
              <td><strong>{cedis(entry.netAmount)}</strong></td>
              <td>
                {entry.status === "RELEASED"
                  ? <><span className="console-badge console-badge-released">Paid</span><small>{when(entry.releasedAt)}{entry.transferReference ? ` · ${entry.transferReference}` : ""}</small></>
                  : entry.releaseAfter <= now
                    ? <span className="console-badge console-badge-active">Ready to pay</span>
                    : <><span className="console-badge console-badge-accrued">Held</span><small>releases {when(entry.releaseAfter)}</small></>}
              </td>
            </tr>)}
          </tbody>
        </table>}

    {statement && statement.batches.length > 0 && <>
      <h3 className="console-subhead">Transfers recorded</h3>
      <table className="console-table">
        <thead><tr><th>Reference</th><th>Bookings</th><th>Amount</th><th>Received</th><th>Recorded</th><th>By</th></tr></thead>
        <tbody>
          {statement.batches.map((batch) => <tr key={batch.id}>
            <td><strong>{batch.transferReference}</strong>{batch.note ? <small>{batch.note}</small> : null}</td>
            <td>{batch.entryCount}</td>
            <td>{cedis(batch.totalAmount)}{batch.transferFee ? <small>fee {cedis(batch.transferFee)}</small> : null}</td>
            <td>{cedis(received(batch))}</td>
            <td>{when(batch.createdAt)}</td>
            <td>{batch.createdBy}</td>
          </tr>)}
        </tbody>
      </table>
    </>}
  </>;
}

function ThreadPanel({ reference, name, onClose }: { reference: string; name: string; onClose: () => void }) {
  const [messages, setMessages] = useState<Message[] | null>(null);
  const latestMessageId = useRef("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/console/hostel/messages?reference=${encodeURIComponent(reference)}`, { credentials: "same-origin", cache: "no-store" });
      const data = await response.json() as { messages?: Message[]; error?: string };
      if (!response.ok) throw new Error(data.error || "That thread could not be loaded.");
      latestMessageId.current = data.messages?.at(-1)?.id || "";
      setMessages(data.messages || []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "That thread could not be loaded.");
      setMessages([]);
    }
  }, [reference]);

  useEffect(() => { queueMicrotask(() => { void load(); }); }, [load]);

  // The resident's reply arrives over the event stream while the panel is open,
  // so the host does not answer a question that was already answered.
  useEffect(() => {
    const after = encodeURIComponent(latestMessageId.current);
    return subscribeToHostelThread(`/api/console/hostel/messages/stream?reference=${encodeURIComponent(reference)}&after=${after}`, () => {
      void load();
    });
  }, [load, reference]);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft.trim()) return;
    setSending(true);
    setError("");
    try {
      const response = await fetch("/api/console/hostel/messages", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reference, content: draft }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "That message was not sent.");
      setDraft("");
      await load();
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "That message was not sent.");
    } finally {
      setSending(false);
    }
  };

  return <section className="console-panel">
    <h2><MessageSquare size={18} aria-hidden />Thread with {name}
      <button type="button" className="console-panel-close" onClick={onClose}>Close</button>
    </h2>
    {error && <div className="console-alert" role="alert">{error}</div>}
    {messages === null
      ? <p className="console-empty"><Loader2 size={15} className="console-spin" aria-hidden /> Loading the thread…</p>
      : messages.length === 0
        ? <p className="console-empty">No messages yet. Say hello and confirm the move-in details.</p>
        : <ul className="console-thread">
          {messages.map((message) => <li key={message.id} className={message.senderType === "HOST" ? "is-mine" : message.senderType === "SYSTEM" ? "is-system" : ""}>
            <strong>{message.senderName || (message.senderType === "STUDENT" ? "Student" : "You")}</strong>
            <span>{message.content}</span>
            <small>{new Date(message.createdAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</small>
          </li>)}
        </ul>}
    <form className="console-form" onSubmit={send}>
      <label className="console-field-wide">Reply
        <textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={3} maxLength={2000} placeholder="Write back to the resident…" />
      </label>
      <button type="submit" disabled={sending || !draft.trim()}>
        {sending ? <Loader2 size={15} className="console-spin" aria-hidden /> : <Send size={15} aria-hidden />}
        Send
      </button>
    </form>
  </section>;
}
