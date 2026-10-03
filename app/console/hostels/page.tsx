"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowCounterClockwise, Bed, Buildings, Check, DoorOpen, MapPin, NotePencil, PaperPlaneTilt, Plus, SealCheck, ShieldCheck, Trash, X } from "@phosphor-icons/react";
import { ConsoleSessionGate } from "@/components/admin/ConsoleSessionGate";
import { ConsoleShell } from "@/components/console/ConsoleShell";
import { ConsoleUnavailable } from "@/components/console/ConsoleUnavailable";
import { HostelReviewQueue } from "@/components/console/hostel/HostelReviewQueue";
import { HostelViewingDesk } from "@/components/console/hostel/HostelViewingDesk";
import { PropertyPhotos } from "@/components/console/hostel/PropertyPhotos";
import { HostelAiDesk } from "@/components/console/hostel/HostelAiDesk";
import { HostelRoomBatch } from "@/components/console/hostel/HostelRoomBatch";
import { HostelLocationPicker } from "@/components/console/hostel/HostelLocationPicker";
import { HostelRateBatch } from "@/components/console/hostel/HostelRateBatch";
import { HostelSubmitBatch } from "@/components/console/hostel/HostelSubmitBatch";
import "@/components/console/hostel/workspace.css";

type SetupOwner = { profileStatus: string; identityStatus: string; payoutStatus: string };

type Landlord = {
  id: string; name: string; phone: string; email: string; organization: string;
  status: string; kycStatus: string; reviewReason: string;
};

type Property = {
  id: string; name: string; address: string;
  latitude: number | null; longitude: number | null;
  utilitiesEnabled: boolean; status: string; createdAt: string;
};

type Space = { id: string; roomId: string; label: string; status: string };

type Room = {
  id: string; propertyId: string; label: string; capacity: number;
  utilitiesFee: number; amenities: string; bedLayout: "SEPARATE" | "BUNK"; status: string; spaces: Space[];
};

type PropertyDetail = { property: Property; rooms: Room[] };
type Period = { id: string; name: string; startsOn: string; endsOn: string };
type Listing = {
  id: string; spaceId: string; periodId: string; price: number; status: string;
  reviewReason: string; submittedAt: string; reviewedAt: string; createdAt: string;
  propertyId: string; propertyName: string; roomLabel: string; spaceLabel: string;
  periodName: string; periodActive: boolean;
};
type RoomDraft = { label: string; capacity: string; utilitiesFee: string; amenities: string; bedLayout: "SEPARATE" | "BUNK" };
type OpenPanel = { kind: "edit" | "beds"; roomId: string } | null;

const EMPTY_ROOM: RoomDraft = { label: "", capacity: "2", utilitiesFee: "0", amenities: "", bedLayout: "SEPARATE" };
/** The engine holds a room to six beds; the form can only offer what it allows. */
const BED_COUNTS = ["1", "2", "3", "4", "5", "6"];
const PAGE_SIZE = 12;

const when = (iso: string) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");
const cedis = (pesewas: number) => `GH₵ ${(Number(pesewas || 0) / 100).toFixed(2)}`;
const cedisInput = (pesewas: number) => (Number(pesewas || 0) / 100).toFixed(2);
const badge = (status: string) => `console-badge console-badge-${status.toLowerCase()}`;
/** Money crosses the API in pesewas, so the cedis a landlord types convert here. */
const toPesewas = (value: string) => Math.round(Number(String(value ?? "0").replace(/,/g, "") || "0") * 100);

export default function HostelWorkspacePage() {
  return <ConsoleSessionGate label="the hostel workspace">
    {(session) => {
      if (session.account.role === "LANDLORD") {
        return <ConsoleShell
          session={session}
          service="hostels"
          label="ACCOMMODATION"
          title="Your hostel workspace"
          blurb="Build the property first, then the rooms and bed-spaces inside it. Students only ever see what review approves."
        >
          <HostelWorkspace />
        </ConsoleShell>;
      }
      if (session.account.role === "ADMIN" || session.account.role === "MODERATOR") {
        return <ConsoleShell
          session={session}
          service="hostels"
          label="ACCOMMODATION"
          title="Hostel listings"
          blurb="Decide which beds students can book, pull one that has gone wrong, and keep the academic years every price is quoted against."
        >
          <HostelReviewQueue session={session} />
        </ConsoleShell>;
      }
      return <ConsoleUnavailable session={session} service="hostels" label="HOSTEL FINDER" blurb="This workspace belongs to a landlord account." />;
    }}
  </ConsoleSessionGate>;
}

function HostelWorkspace() {
  const [landlord, setLandlord] = useState<Landlord | null>(null);
  const [setupOwner, setSetupOwner] = useState<SetupOwner | null>(null);
  const [properties, setProperties] = useState<Property[] | null>(null);
  const [detail, setDetail] = useState<PropertyDetail | null>(null);
  const [draft, setDraft] = useState({ name: "", address: "", latitude: "", longitude: "", utilitiesEnabled: false });
  const [propertyEdit, setPropertyEdit] = useState<{ name: string; address: string; latitude: string; longitude: string; utilitiesEnabled: boolean } | null>(null);
  const [roomDraft, setRoomDraft] = useState<RoomDraft>({ ...EMPTY_ROOM });
  const [roomEdit, setRoomEdit] = useState<(RoomDraft & { id: string; status: string }) | null>(null);
  const [panels, setPanels] = useState<OpenPanel>(null);
  const [bedNames, setBedNames] = useState<Record<string, string>>({});
  const [periods, setPeriods] = useState<Period[] | null>(null);
  const [listings, setListings] = useState<Listing[] | null>(null);
  const [listingDraft, setListingDraft] = useState({ roomId: "", periodId: "", price: "" });
  const [listingEdit, setListingEdit] = useState<{ id: string; price: string } | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState("");
  const [mobileSection, setMobileSection] = useState<"overview" | "rooms" | "rates" | "media" | "assistant">("overview");
  const [roomPage, setRoomPage] = useState(0);
  const [listingPage, setListingPage] = useState(0);
  const [compact, setCompact] = useState(false);
  const [roomSearch, setRoomSearch] = useState("");
  const [listingSearch, setListingSearch] = useState("");
  const [listingStatus, setListingStatus] = useState("ALL");
  const [expandedListingId, setExpandedListingId] = useState("");
  const [roomMode, setRoomMode] = useState<"manage" | "add">("manage");
  const [rateMode, setRateMode] = useState<"manage" | "price">("manage");
  const [singleRoomOpen, setSingleRoomOpen] = useState(false);
  const [mediaSection, setMediaSection] = useState<"photos" | "viewings">("photos");
  const [createOpen, setCreateOpen] = useState(false);
  const createDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const update = () => { setCompact(media.matches); setRoomPage(0); setListingPage(0); };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const node = createDialog.current;
    if (createOpen && node && !node.open) node.showModal();
    if (!createOpen && node?.open) node.close();
  }, [createOpen]);

  const load = useCallback(async () => {
    try {
      const [propertiesResponse, setupResponse] = await Promise.all([
        fetch("/api/console/hostel/properties", { credentials: "same-origin", cache: "no-store" }),
        fetch("/api/console/hostel/onboarding", { credentials: "same-origin", cache: "no-store" }),
      ]);
      const [data, setup] = await Promise.all([propertiesResponse.json(), setupResponse.json()]);
      if (!propertiesResponse.ok) throw new Error(data.error || "Your hostel workspace could not be loaded.");
      if (!setupResponse.ok) throw new Error(setup.error || "Setup approval status could not be loaded.");
      setLandlord(data.landlord);
      setSetupOwner(setup.owner);
      setProperties(data.properties || []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Your hostel workspace could not be loaded.");
    }
  }, []);

  const loadPeriods = useCallback(async () => {
    try {
      const response = await fetch("/api/hostel/periods", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The open academic years could not be loaded.");
      setPeriods(data.periods || []);
    } catch (loadError) {
      setPeriods([]);
      setError(loadError instanceof Error ? loadError.message : "The open academic years could not be loaded.");
    }
  }, []);

  useEffect(() => {
    queueMicrotask(load);
    queueMicrotask(loadPeriods);
  }, [load, loadPeriods]);

  async function request(path: string, init: RequestInit) {
    const response = await fetch(path, { credentials: "same-origin", ...init });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "That change could not be saved.");
    return data;
  }

  /** One read, one place: every mutation ends here so the tree on screen is the tree in the database. */
  const refreshDetail = useCallback(async (propertyId: string) => {
    const data = await request(`/api/console/hostel/properties/${encodeURIComponent(propertyId)}`, { cache: "no-store" });
    setDetail({ property: data.property, rooms: data.rooms || [] });
  }, []);

  /** One read, one place: the listings table always shows what the database holds. */
  const refreshListings = useCallback(async (propertyId: string) => {
    const data = await request(`/api/console/hostel/listings?propertyId=${encodeURIComponent(propertyId)}`, { cache: "no-store" });
    setListings(data.listings || []); setListingPage(0);
  }, []);

  async function openProperty(property: Property) {
    setBusy(`open:${property.id}`); setError(""); setSaved("");
    setPanels(null); setRoomEdit(null); setListings(null); setListingEdit(null); setRoomPage(0); setListingPage(0); setRoomSearch(""); setListingSearch(""); setListingStatus("ALL"); setExpandedListingId(""); setRoomMode("manage"); setRateMode("manage"); setMobileSection("overview");
    try {
      await refreshDetail(property.id);
      await refreshListings(property.id);
      setPropertyEdit(null);
      requestAnimationFrame(() => document.getElementById(window.matchMedia("(max-width: 760px)").matches ? "hostel-mobile-context" : "hostel-property")?.scrollIntoView({ behavior: "smooth", block: "start" }));
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : "That property could not be opened.");
    } finally {
      setBusy("");
    }
  }

  async function submitPropertyReview() {
    if (!detail || detail.property.status !== "DRAFT") return;
    setBusy("property-review"); setError(""); setSaved("");
    try {
      await request("/api/console/hostel/properties/review", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ propertyId: detail.property.id }),
      });
      await Promise.all([refreshDetail(detail.property.id), load()]);
      setSaved("Property submitted. Staff will review the building separately from its bed listings.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Property could not be submitted for review.");
    } finally { setBusy(""); }
  }

  async function addProperty(event: FormEvent) {
    event.preventDefault();
    setBusy("property"); setError(""); setSaved("");
    try {
      const data = await request("/api/console/hostel/properties", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      const property = data.property as Property;
      setProperties((current) => [property, ...(current || [])]);
      setDraft({ name: "", address: "", latitude: "", longitude: "", utilitiesEnabled: false });
      setCreateOpen(false);
      await openProperty(property);
      setSaved(`${property.name} saved as a draft. Complete its location and building photos before review.`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The property could not be saved.");
    } finally {
      setBusy("");
    }
  }

  async function savePropertyEdit(event: FormEvent) {
    event.preventDefault();
    if (!propertyEdit || !detail) return;
    setBusy("property-edit"); setError(""); setSaved("");
    try {
      const data = await request(`/api/console/hostel/properties/${encodeURIComponent(detail.property.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(propertyEdit),
      });
      setSaved(`${data.property.name} updated.`);
      setPropertyEdit(null);
      await load();
      await refreshDetail(detail.property.id);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The property could not be saved.");
    } finally {
      setBusy("");
    }
  }

  async function addRoom(event: FormEvent) {
    event.preventDefault();
    if (!detail) return;
    setBusy("room"); setError(""); setSaved("");
    try {
      const data = await request("/api/console/hostel/rooms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          propertyId: detail.property.id,
          label: roomDraft.label,
          capacity: Number(roomDraft.capacity),
          utilitiesFee: toPesewas(roomDraft.utilitiesFee),
          amenities: roomDraft.amenities,
          bedLayout: roomDraft.bedLayout,
        }),
      });
      const room = data.room as Room;
      setRoomDraft({ ...EMPTY_ROOM }); setSingleRoomOpen(false);
      setSaved(`${room.label} added with ${room.spaces.length} ${room.spaces.length === 1 ? "bed" : "beds"}.`);
      await refreshDetail(detail.property.id);
      setRoomMode("manage");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The room could not be saved.");
    } finally {
      setBusy("");
    }
  }

  async function saveRoomEdit(event: FormEvent) {
    event.preventDefault();
    if (!roomEdit || !detail) return;
    setBusy("room-edit"); setError(""); setSaved("");
    try {
      const data = await request(`/api/console/hostel/rooms/${encodeURIComponent(roomEdit.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: roomEdit.label,
          capacity: Number(roomEdit.capacity),
          utilitiesFee: toPesewas(roomEdit.utilitiesFee),
          amenities: roomEdit.amenities,
          bedLayout: roomEdit.bedLayout,
          status: roomEdit.status,
        }),
      });
      const room = data.room as Room;
      setRoomEdit(null); setPanels(null);
      setSaved(`${room.label} saved with ${room.spaces.filter((space) => space.status !== "RETIRED").length} live ${room.spaces.filter((space) => space.status !== "RETIRED").length === 1 ? "bed" : "beds"}.`);
      await refreshDetail(detail.property.id);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The room could not be saved.");
    } finally {
      setBusy("");
    }
  }

  async function saveBedName(space: Space) {
    if (!detail) return;
    setBusy(space.id); setError(""); setSaved("");
    try {
      const data = await request(`/api/console/hostel/spaces/${encodeURIComponent(space.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: bedNames[space.id] ?? space.label }),
      });
      setSaved(`${space.label} is now ${data.space.label}.`);
      await refreshDetail(detail.property.id);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The bed could not be renamed.");
    } finally {
      setBusy("");
    }
  }

  async function setBedStatus(space: Space, status: "AVAILABLE" | "RETIRED") {
    if (!detail) return;
    setBusy(space.id); setError(""); setSaved("");
    try {
      await request(`/api/console/hostel/spaces/${encodeURIComponent(space.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      setSaved(`${space.label} ${status === "RETIRED" ? "retired from the room" : "is back in the room"}.`);
      await refreshDetail(detail.property.id);
    } catch (statusError) {
      setError(statusError instanceof Error ? statusError.message : "The bed could not be changed.");
    } finally {
      setBusy("");
    }
  }

  async function addListing(event: FormEvent) {
    event.preventDefault();
    if (!detail) return;
    setBusy("listing"); setError(""); setSaved("");
    try {
      const data = await request("/api/console/hostel/room-rates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomId: listingDraft.roomId, periodId: listingDraft.periodId, price: toPesewas(listingDraft.price) }),
      });
      const rate = data.rate as { roomLabel: string; bedCount: number; periodId: string; periodName: string };
      setListingDraft({ roomId: "", periodId: rate.periodId, price: "" });
      setSaved(`${rate.roomLabel}: all ${rate.bedCount} beds now share the same annual rent for ${rate.periodName}. Submit new drafts for review.`);
      await refreshListings(detail.property.id);
      setRateMode("manage");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "That bed could not be priced.");
    } finally {
      setBusy("");
    }
  }

  async function submitListing(listing: Listing) {
    if (!detail) return;
    setBusy(listing.id); setError(""); setSaved("");
    try {
      await request(`/api/console/hostel/listings/${encodeURIComponent(listing.id)}/review`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "SUBMIT" }),
      });
      setSaved(`${listing.roomLabel} · ${listing.spaceLabel} is with the reviewers for ${listing.periodName}.`);
      await refreshListings(detail.property.id);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "That listing could not be submitted.");
    } finally {
      setBusy("");
    }
  }

  async function saveListingPrice(listing: Listing) {
    if (!detail || listingEdit?.id !== listing.id) return;
    const room = detail.rooms.find(item => item.label === listing.roomLabel);
    if (!room) { setError("Open the room again before changing its rate."); return; }
    setBusy(listing.id); setError(""); setSaved("");
    try {
      await request("/api/console/hostel/room-rates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomId: room.id, periodId: listing.periodId, price: toPesewas(listingEdit.price) }),
      });
      setListingEdit(null);
      setSaved("Room rate saved for every bed. Changed offers are back in draft for review.");
      await refreshListings(detail.property.id);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "That rent could not be saved.");
    } finally {
      setBusy("");
    }
  }

  async function removeListing(listing: Listing) {
    if (!detail) return;
    setBusy(listing.id); setError(""); setSaved("");
    try {
      await request(`/api/console/hostel/listings/${encodeURIComponent(listing.id)}`, { method: "DELETE" });
      setSaved(`${listing.roomLabel} · ${listing.spaceLabel} is withdrawn from ${listing.periodName}.`);
      await refreshListings(detail.property.id);
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "That listing could not be withdrawn.");
    } finally {
      setBusy("");
    }
  }

  const openRoom = detail?.rooms.find((room) => room.id === (panels?.roomId || roomEdit?.id)) || null;
  const ownerSetupApproved = setupOwner?.profileStatus === "APPROVED" && setupOwner.identityStatus === "VERIFIED" && setupOwner.payoutStatus === "APPROVED";
  const setupComplete = ownerSetupApproved && (properties?.some(property => property.status === "APPROVED") ?? false);
  const roomSetupApproved = ownerSetupApproved && detail?.property.status === "APPROVED";
  const pageSize = compact ? 4 : PAGE_SIZE;
  const filteredRooms = (detail?.rooms || []).filter(room => `${room.label} ${room.amenities}`.toLowerCase().includes(roomSearch.trim().toLowerCase()));
  const filteredListings = (listings || []).filter(listing =>
    (listingStatus === "ALL" || listing.status === listingStatus) &&
    `${listing.roomLabel} ${listing.spaceLabel} ${listing.periodName}`.toLowerCase().includes(listingSearch.trim().toLowerCase()));
  const activeRoomPage = Math.min(roomPage, Math.max(0, Math.ceil(filteredRooms.length / pageSize) - 1));
  const activeListingPage = Math.min(listingPage, Math.max(0, Math.ceil(filteredListings.length / pageSize) - 1));
  const shownRooms = filteredRooms.slice(activeRoomPage * pageSize, (activeRoomPage + 1) * pageSize);
  const shownListings = filteredListings.slice(activeListingPage * pageSize, (activeListingPage + 1) * pageSize);
  const showRoomPage = (page: number) => { setRoomPage(page); requestAnimationFrame(() => document.getElementById("hostel-rooms")?.scrollIntoView({ behavior: "smooth", block: "start" })); };
  const showListingPage = (page: number) => { setListingPage(page); setExpandedListingId(""); requestAnimationFrame(() => document.getElementById("hostel-rates")?.scrollIntoView({ behavior: "smooth", block: "start" })); };

  return <div className="hostel-workspace" data-mobile-focused={detail ? "true" : "false"}>
    <div className="hostel-workspace-intro">
      <div><span className="hostel-workspace-eyebrow">PROPERTY MANAGEMENT</span><p>Open a building to manage its rooms, prices, media and review status.</p></div>
      <div className="hostel-workspace-quicklinks"><Link href="/console/hostels/guide" className="hostel-workspace-primary">Staff guide & assistant →</Link>{setupComplete ? <button type="button" className="hostel-workspace-primary" onClick={() => setCreateOpen(true)}>Add property +</button> : <Link href="/console/hostels/onboarding" className="hostel-workspace-primary">Continue setup →</Link>}</div>
    </div>
    {detail && <div className="hostel-mobile-context" id="hostel-mobile-context"><button type="button" onClick={() => { setDetail(null); setPropertyEdit(null); setPanels(null); setRoomEdit(null); setMobileSection("overview"); requestAnimationFrame(() => document.getElementById("hostel-overview")?.scrollIntoView({ behavior: "smooth", block: "start" })); }}>← All properties</button><strong>{detail.property.name}</strong><span className={badge(detail.property.status)}>{detail.property.status.replace("_", " ")}</span></div>}
    <div className="hostel-workspace-metrics" aria-label="Workspace overview" data-mobile-section="overview" data-active={mobileSection === "overview"}>
      <div><strong>{properties?.length ?? "—"}</strong><span>{properties?.length === 1 ? "Property" : "Properties"}</span></div>
      <div><strong>{properties?.filter(property => property.status === "APPROVED").length ?? "—"}</strong><span>Approved</span></div>
      {detail && <><div><strong>{detail.rooms.length}</strong><span>Rooms in focus</span></div>
      <div><strong>{detail.rooms.reduce((count, room) => count + room.spaces.filter(space => space.status === "AVAILABLE").length, 0)}</strong><span>Available bed spaces</span></div></>}
    </div>
    {detail && <nav className="hostel-workspace-mobile-nav" aria-label="Hostel workspace tasks">{(["overview", "rooms", "rates", "media", "assistant"] as const).map(section => <button type="button" key={section} aria-current={mobileSection === section ? "page" : undefined} onClick={() => { setMobileSection(section); setError(""); setSaved(""); }}>{section === "overview" ? "Overview" : section === "media" ? "Photos & visits" : section === "assistant" ? "AI info" : section === "rates" ? "Rates" : "Rooms"}</button>)}</nav>}
    {detail && <nav className="hostel-workspace-jumps" aria-label="Property workspace sections"><a href="#hostel-property">Property</a><a href="#hostel-rooms">Rooms</a><a href="#hostel-rates">Rates</a><a href="#hostel-assistant">Assistant</a></nav>}
    {error && <div className="console-alert" role="alert">{error}</div>}
    {saved && !error && <div className="console-alert console-alert-ok" role="status">{saved}</div>}

    <div className="hostel-workspace-overview" id="hostel-overview" data-mobile-section="overview" data-active={mobileSection === "overview"}>
    {!setupComplete && <section className="console-panel hostel-workspace-account">
      <h2><ShieldCheck size={18}/>Landlord account
        {landlord && <span className={badge(landlord.kycStatus === "VERIFIED" ? "APPROVED" : landlord.kycStatus)}>KYC {landlord.kycStatus}</span>}
      </h2>
      {landlord && <p className="console-note">
        <strong>{landlord.organization || landlord.name}</strong> · {landlord.phone} · {landlord.email}
      </p>}
      <p className="console-note">
        Your account is active. Complete the three-step setup so staff can review owner identity, property details and payout destination separately.
      </p>
      <Link href="/console/hostels/onboarding" className="console-onboarding-link">Open setup &amp; verification →</Link>
    </section>}

    {!setupComplete && <section className="console-panel hostel-workspace-add">
      <span className="hostel-workspace-eyebrow">GROW YOUR PORTFOLIO</span>
      <h2><Buildings size={18}/>{properties?.length ? "Add another property" : "Create your first property"}</h2>
      <p className="console-note">Start with the building name and address. Add its precise location and building photos during setup; rooms follow approval.</p>
      <button type="button" className="hostel-workspace-create-button" onClick={() => setCreateOpen(true)}><Plus size={17}/> Create property</button>
    </section>}
    <dialog ref={createDialog} className="hostel-batch-dialog hostel-create-dialog" aria-labelledby="hostel-create-title" onCancel={(event) => { if (busy === "property") event.preventDefault(); else setCreateOpen(false); }} onClick={(event) => { if (event.target === event.currentTarget && busy !== "property") setCreateOpen(false); }}>
        <div className="hostel-batch-inner"><header><div><span>NEW BUILDING</span><h2 id="hostel-create-title">Create a property draft</h2><p>Start with the essentials, then complete staff review in setup.</p></div><button type="button" aria-label="Close" disabled={busy === "property"} onClick={() => setCreateOpen(false)}><X size={20}/></button></header>
          <form className="console-form" onSubmit={addProperty}>
            <label>Property name<input type="text" required minLength={2} maxLength={80} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Green View Hostel" /></label>
            <label>Address<input type="text" required minLength={3} maxLength={160} value={draft.address} onChange={(event) => setDraft({ ...draft, address: event.target.value })} placeholder="Near UMaT main gate, Tarkwa" /></label>
            <label className="console-check-field"><input type="checkbox" checked={draft.utilitiesEnabled} onChange={(event) => setDraft({ ...draft, utilitiesEnabled: event.target.checked })} /> Charge utilities per bed</label>
            <p className="console-note">A confirmed property pin is required before staff can approve the building. You can add it after creating this draft.</p>
            <footer><button type="button" className="hostel-batch-cancel" disabled={busy === "property"} onClick={() => setCreateOpen(false)}>Cancel</button><button type="submit" disabled={busy === "property"}><Plus size={16}/>{busy === "property" ? "Saving…" : "Create draft"}</button></footer>
          </form>
        </div>
    </dialog>

    <section className="console-panel hostel-workspace-properties">
      <h2><Bed size={18}/>Your properties</h2>
      {!properties
        ? <p className="console-empty">Loading your properties…</p>
        : properties.length === 0
          ? <div className="hostel-workspace-empty"><p className="console-empty">No properties yet. Create your first building, then add its location and photos for review.</p><button type="button" onClick={() => setCreateOpen(true)}><Plus size={16}/> Create first property</button></div>
          : <div className="hostel-property-grid">
            {properties.map((property) => <article className={`hostel-property-tile${detail?.property.id === property.id ? " is-selected" : ""}`} key={property.id}>
              <div className="hostel-property-tile-top"><span>HOSTEL PROPERTY</span><span className={badge(property.status)}>{property.status.replace("_", " ")}</span></div>
              <h3>{property.name}</h3><p>{property.address || "Address still needed"}</p>
              <div className="hostel-property-tile-meta"><span><MapPin size={15}/>{property.latitude !== null && property.longitude !== null ? "Location pinned" : "Location needed"}</span><span>{property.utilitiesEnabled ? "Utilities per bed" : "Rent only"}</span><span>Added {when(property.createdAt)}</span></div>
              <button type="button" disabled={busy === `open:${property.id}`} onClick={() => void openProperty(property)}><DoorOpen size={17}/>{busy === `open:${property.id}` ? "Opening…" : detail?.property.id === property.id ? "Manage selected property" : "Manage property"}</button>
            </article>)}
          </div>}
      <p className="console-note">A property becomes public after staff approve the building. Beds and prices require their own review.</p>
    </section>

    </div>

    {detail && <div data-mobile-section="overview" data-active={mobileSection === "overview"}><section className="console-panel" id="hostel-property">
      <h2><Buildings size={18}/>{detail.property.name}
        <span className={badge(detail.property.status)}>{detail.property.status.replace("_", " ")}</span>
        <button className="console-panel-close" onClick={() => setPropertyEdit(propertyEdit
          ? null
          : {
            name: detail.property.name,
            address: detail.property.address,
            latitude: detail.property.latitude === null ? "" : String(detail.property.latitude),
            longitude: detail.property.longitude === null ? "" : String(detail.property.longitude),
            utilitiesEnabled: detail.property.utilitiesEnabled,
          })}>
          <NotePencil size={14}/>{propertyEdit ? "Close editor" : "Edit details"}
        </button>
      </h2>
      <p className="console-note">
        {detail.property.address || "No address yet"} · {detail.property.utilitiesEnabled ? "Utilities fee per bed applies" : "Rent only"} · {detail.rooms.length} {detail.rooms.length === 1 ? "room" : "rooms"}
      </p>

      <div className={`hostel-publication-status is-${detail.property.status.toLowerCase()}`} role="status">
        <div><span className="hostel-publication-eyebrow">STUDENT VISIBILITY</span>
          <strong>{detail.property.status === "APPROVED" ? "Property visible to students" : detail.property.status === "PENDING_REVIEW" ? "Property awaiting staff approval" : detail.property.status === "SUSPENDED" ? "Property suspended" : "Property is not public yet"}</strong>
          <p>{detail.property.status === "APPROVED"
            ? `${listings?.filter(item => item.status === "APPROVED" && item.periodActive).length || 0} approved bed listings. Students can browse this building; only approved available beds can be booked.`
            : detail.property.status === "PENDING_REVIEW" ? "Your property is in the staff queue. Approved photos alone do not publish a building."
            : detail.property.status === "SUSPENDED" ? "Staff have paused this building. Contact the platform team for the review reason."
            : detail.property.latitude === null || detail.property.longitude === null
              ? "Add and save a location pin first. Approved photos and rooms do not approve the building; staff must review the property separately."
              : "A saved building and approved photos are separate from property approval. Submit the building for review to publish it."}</p>
        </div>
        {detail.property.status === "DRAFT" && (detail.property.latitude === null || detail.property.longitude === null
          ? <button type="button" onClick={() => setPropertyEdit({ name: detail.property.name, address: detail.property.address, latitude: "", longitude: "", utilitiesEnabled: detail.property.utilitiesEnabled })}>Set property location</button>
          : <button type="button" disabled={Boolean(busy)} onClick={() => void submitPropertyReview()}>{busy === "property-review" ? "Submitting…" : "Submit property for review"}</button>)}
        {detail.property.status === "APPROVED" && <Link href={`/hostel/${encodeURIComponent(detail.property.id)}`} target="_blank" rel="noopener noreferrer">View student page ↗</Link>}
      </div>
      {propertyEdit && <form className="console-form" onSubmit={savePropertyEdit}>
        <label>Property name
          <input type="text" required minLength={2} maxLength={80} value={propertyEdit.name} onChange={(event) => setPropertyEdit({ ...propertyEdit, name: event.target.value })} />
        </label>
        <label>Address
          <input type="text" required minLength={3} maxLength={160} value={propertyEdit.address} onChange={(event) => setPropertyEdit({ ...propertyEdit, address: event.target.value })} />
        </label>
        <div className="hostel-workspace-location"><HostelLocationPicker latitude={propertyEdit.latitude} longitude={propertyEdit.longitude} onChange={(latitude, longitude) => setPropertyEdit(current => current ? { ...current, latitude, longitude } : current)}/></div>
        <label>Latitude
          <input type="text" inputMode="decimal" value={propertyEdit.latitude} onChange={(event) => setPropertyEdit({ ...propertyEdit, latitude: event.target.value })} placeholder="5.3009" />
        </label>
        <label>Longitude
          <input type="text" inputMode="decimal" value={propertyEdit.longitude} onChange={(event) => setPropertyEdit({ ...propertyEdit, longitude: event.target.value })} placeholder="-1.9897" />
        </label>
        <label className="console-check-field">
          <input type="checkbox" checked={propertyEdit.utilitiesEnabled} onChange={(event) => setPropertyEdit({ ...propertyEdit, utilitiesEnabled: event.target.checked })} /> Charge a utilities fee per bed
        </label>
        <button disabled={busy === "property-edit"}><Check size={16}/>{busy === "property-edit" ? "Saving…" : "Save details"}</button>
      </form>}
    </section></div>}

    {detail && <div data-mobile-section="media" data-active={mobileSection === "media"}><div className="hostel-media-switch"><button type="button" aria-current={mediaSection === "photos" ? "page" : undefined} onClick={() => setMediaSection("photos")}>Photos & floor plans</button><button type="button" aria-current={mediaSection === "viewings" ? "page" : undefined} onClick={() => setMediaSection("viewings")}>Viewing requests</button></div>
    {mediaSection === "viewings" && <HostelViewingDesk propertyId={detail.property.id} />}

    {mediaSection === "photos" && <PropertyPhotos
      propertyId={detail.property.id}
      propertyName={detail.property.name}
      rooms={detail.rooms.map((room) => ({ id: room.id, label: room.label }))}
      onNotice={setSaved}
    />}</div>}

    {detail && <div data-mobile-section="rooms" data-active={mobileSection === "rooms"}>
    {roomSetupApproved && detail.rooms.length > 0 && <nav className="hostel-workspace-task-switch" aria-label="Room tasks"><button type="button" aria-current={roomMode === "manage" ? "page" : undefined} onClick={() => setRoomMode("manage")}>Manage rooms <span>{detail.rooms.length}</span></button><button type="button" aria-current={roomMode === "add" ? "page" : undefined} onClick={() => { setRoomMode("add"); setRoomEdit(null); setPanels(null); }}>Add rooms</button></nav>}
    {!roomSetupApproved && <section className="console-panel hostel-room-create" role="status"><h2><ShieldCheck size={18}/>Rooms open after setup approval</h2><p className="console-note">Complete the separate reviews for account details, identity, payout destination and this property. Once all four are approved, return here to add rooms and beds.</p><Link href="/console/hostels/onboarding" className="console-onboarding-link">Check setup progress →</Link></section>}
    {roomSetupApproved && <section className="console-panel hostel-room-create" data-task-active={roomMode === "add" || detail.rooms.length === 0}>
      <h2><Plus size={18}/>Add rooms to {detail.property.name}</h2>
      <p className="console-note">Create a numbered range with matching beds and features in batches, or add one room manually.</p>
      <HostelRoomBatch key={detail.property.id} propertyId={detail.property.id} propertyName={detail.property.name} canPrice={landlord?.kycStatus === "VERIFIED"} roomTemplates={detail.rooms} onComplete={async message => { setSaved(message); await Promise.all([refreshDetail(detail.property.id), refreshListings(detail.property.id)]); setRoomMode("manage"); }} />
      <button type="button" className="hostel-single-room-toggle" onClick={() => setSingleRoomOpen(value => !value)}>{singleRoomOpen ? "Hide single-room form" : "Add one room manually"}</button>
      {singleRoomOpen && <>
      <form className="console-form" onSubmit={addRoom}>
        <label>Room name
          <input type="text" required minLength={1} maxLength={24} value={roomDraft.label} onChange={(event) => setRoomDraft({ ...roomDraft, label: event.target.value })} placeholder="Room 3" />
        </label>
        <label>Student bed spaces in the room
          <select value={roomDraft.capacity} onChange={(event) => setRoomDraft({ ...roomDraft, capacity: event.target.value })}>
            {BED_COUNTS.filter(count => roomDraft.bedLayout !== "BUNK" || Number(count) % 2 === 0).map((count) => <option key={count} value={count}>{count}</option>)}
          </select>
        </label>
        <label>Bed arrangement<select value={roomDraft.bedLayout} onChange={event => setRoomDraft({ ...roomDraft, bedLayout: event.target.value as "SEPARATE" | "BUNK", capacity: event.target.value === "BUNK" && Number(roomDraft.capacity) % 2 ? String(Number(roomDraft.capacity) + 1) : roomDraft.capacity })}><option value="SEPARATE">Separate beds</option><option value="BUNK">Bunk beds</option></select></label>
        <p className="console-note">One bunk unit has two student spaces: a lower and an upper bed.</p>
        <label>Utilities fee per bed (GH₵)
          <input type="text" inputMode="decimal" value={roomDraft.utilitiesFee} onChange={(event) => setRoomDraft({ ...roomDraft, utilitiesFee: event.target.value })} placeholder="0.00" />
        </label>
        <label>Amenities
          <input type="text" maxLength={200} value={roomDraft.amenities} onChange={(event) => setRoomDraft({ ...roomDraft, amenities: event.target.value })} placeholder="AC, wardrobe, private bath" />
        </label>
        <button disabled={busy === "room"}><Plus size={16}/>{busy === "room" ? "Saving…" : "Add room & beds"}</button>
      </form>
      <p className="console-note">
        Each student bed space is created separately. Bunk layouts name lower and upper places, so students choose their own bed rather than booking the entire room.
      </p></>}
    </section>}

    {detail && <section className="console-panel hostel-room-manage" id="hostel-rooms" data-task-active={roomMode === "manage" && detail.rooms.length > 0}>
      <h2><Bed size={18}/>Rooms and beds</h2>
      {detail.rooms.length > 5 && <div className="hostel-list-toolbar"><label>Find a room<input type="search" value={roomSearch} onChange={event => { setRoomSearch(event.target.value); setRoomPage(0); }} placeholder="Search room number or feature" /></label><span>{filteredRooms.length} of {detail.rooms.length} rooms</span></div>}
      {filteredRooms.length === 0
        ? <p className="console-empty">{detail.rooms.length ? "No rooms match that search." : "No rooms yet. Add the first one above."}</p>
        : <table className="console-table">
          <thead><tr><th>Room</th><th>Beds</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {shownRooms.map((room) => {
              const live = room.spaces.filter((space) => space.status !== "RETIRED");
              return <tr key={room.id}>
                <td data-label="Room">
                  <strong>{room.label}</strong>
                  <small>Sleeps {room.capacity} · {room.bedLayout === "BUNK" ? `${room.capacity / 2} bunk unit${room.capacity === 2 ? "" : "s"} (upper and lower)` : "Separate beds"} · {room.utilitiesFee > 0 ? `${cedis(room.utilitiesFee)} per bed` : "Utilities included"}</small>
                  {room.amenities && <small>{room.amenities}</small>}
                </td>
                <td data-label="Beds">
                  <span>{live.length} live {live.length === 1 ? "bed" : "beds"}</span>
                  <small>{room.spaces.map((space) => space.label).join(", ") || "No beds yet"}</small>
                </td>
                <td data-label="Status"><span className={badge(room.status)}>{room.status}</span></td>
                <td className="console-row-actions" data-label="Actions">
                  <button disabled={busy === "room-edit"} onClick={() => {
                    setPanels(null);
                    setRoomEdit({
                      id: room.id,
                      label: room.label,
                      capacity: String(room.capacity),
                      utilitiesFee: cedisInput(room.utilitiesFee),
                      amenities: room.amenities,
                      bedLayout: room.bedLayout,
                      status: room.status,
                    });
                    setError(""); setSaved("");
                  }}><NotePencil size={15}/>Edit</button>
                  <button onClick={() => {
                    setRoomEdit(null);
                    setPanels(panels?.kind === "beds" && panels.roomId === room.id ? null : { kind: "beds", roomId: room.id });
                    setError(""); setSaved("");
                  }}><DoorOpen size={15}/>{panels?.kind === "beds" && panels.roomId === room.id ? "Close beds" : "Beds"}</button>
                </td>
              </tr>;
            })}
          </tbody>
        </table>}
      {filteredRooms.length > pageSize && <div className="hostel-page-controls"><span>Rooms {activeRoomPage * pageSize + 1}–{Math.min((activeRoomPage + 1) * pageSize, filteredRooms.length)} of {filteredRooms.length}</span><button type="button" disabled={activeRoomPage === 0} onClick={() => showRoomPage(activeRoomPage - 1)}>Previous</button><button type="button" disabled={(activeRoomPage + 1) * pageSize >= filteredRooms.length} onClick={() => showRoomPage(activeRoomPage + 1)}>Next</button></div>}
      <p className="console-note">
        Shrinking a room retires its highest beds for you; growing it adds more. A bed with a live listing is never retired behind your back.
      </p>
    </section>}

    {detail && roomEdit && <section className="console-panel">
      <h2><NotePencil size={18}/>Edit {roomEdit.label}
        <button className="console-panel-close" onClick={() => setRoomEdit(null)}>Close</button>
      </h2>
      <form className="console-form" onSubmit={saveRoomEdit}>
        <label>Room name
          <input type="text" required minLength={1} maxLength={24} value={roomEdit.label} onChange={(event) => setRoomEdit({ ...roomEdit, label: event.target.value })} />
        </label>
        <label>Student bed spaces in the room
          <select value={roomEdit.capacity} onChange={(event) => setRoomEdit({ ...roomEdit, capacity: event.target.value })}>
            {BED_COUNTS.filter(count => roomEdit.bedLayout !== "BUNK" || Number(count) % 2 === 0).map((count) => <option key={count} value={count}>{count}</option>)}
          </select>
        </label>
        <label>Bed arrangement<select value={roomEdit.bedLayout} onChange={event => setRoomEdit({ ...roomEdit, bedLayout: event.target.value as "SEPARATE" | "BUNK", capacity: event.target.value === "BUNK" && Number(roomEdit.capacity) % 2 ? String(Number(roomEdit.capacity) + 1) : roomEdit.capacity })}><option value="SEPARATE">Separate beds</option><option value="BUNK">Bunk beds</option></select></label>
        <p className="console-note">One bunk unit has two student spaces: a lower and an upper bed. If you change an existing room to bunks, rename its bed spaces below to show which are lower and upper.</p>
        <label>Utilities fee per bed (GH₵)
          <input type="text" inputMode="decimal" value={roomEdit.utilitiesFee} onChange={(event) => setRoomEdit({ ...roomEdit, utilitiesFee: event.target.value })} />
        </label>
        <label>Amenities
          <input type="text" maxLength={200} value={roomEdit.amenities} onChange={(event) => setRoomEdit({ ...roomEdit, amenities: event.target.value })} />
        </label>
        <label>Status
          <select value={roomEdit.status} onChange={(event) => setRoomEdit({ ...roomEdit, status: event.target.value })}>
            <option value="ACTIVE">ACTIVE — bookable</option>
            <option value="RETIRED">RETIRED — off the market</option>
          </select>
        </label>
        <button disabled={busy === "room-edit"}><Check size={16}/>{busy === "room-edit" ? "Saving…" : "Save room"}</button>
        <button type="button" className="console-secondary" onClick={() => setRoomEdit(null)}>Cancel</button>
      </form>
      <p className="console-note">
        Retiring a room takes it off the market and retires every bed inside it. Beds that students already booked are refused: cancel those listings first.
      </p>
    </section>}

    {detail && openRoom && panels?.kind === "beds" && <section className="console-panel">
      <h2><DoorOpen size={18}/>Beds · {openRoom.label}
        <button className="console-panel-close" onClick={() => setPanels(null)}>Close</button>
      </h2>
      {openRoom.spaces.length === 0
        ? <p className="console-empty">This room has no beds yet. Set its size in the room editor.</p>
        : <table className="console-table">
          <thead><tr><th>Bed name</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {openRoom.spaces.map((space) => {
              const typed = bedNames[space.id] ?? space.label;
              return <tr key={space.id}>
                <td data-label="Bed name">
                  <input
                    type="text"
                    aria-label={`Name for ${space.label}`}
                    maxLength={24}
                    value={typed}
                    onChange={(event) => setBedNames({ ...bedNames, [space.id]: event.target.value })}
                  />
                </td>
                <td data-label="Status"><span className={badge(space.status)}>{space.status}</span></td>
                <td className="console-row-actions" data-label="Actions">
                  <button disabled={busy === space.id || typed.trim() === space.label || typed.trim().length === 0} onClick={() => void saveBedName(space)}>
                    <Check size={15}/>Save name
                  </button>
                  {space.status === "RETIRED"
                    ? <button disabled={busy === space.id} onClick={() => void setBedStatus(space, "AVAILABLE")}><ArrowCounterClockwise size={15}/>Restore</button>
                    : <button disabled={busy === space.id} onClick={() => void setBedStatus(space, "RETIRED")}><Trash size={15}/>Retire</button>}
                </td>
              </tr>;
            })}
          </tbody>
        </table>}
      <p className="console-note">
        Rename a bed to match the room — <strong>Bed A</strong>, <strong>Top bunk</strong>, whatever a student sees. Retiring a bed keeps it on old records but hides it from new bookings.
      </p>
    </section>}

    </div>}

    {detail && landlord?.kycStatus !== "VERIFIED" && <div data-mobile-section="rates" data-active={mobileSection === "rates"}><section className="console-panel" id="hostel-rates"><h2><ShieldCheck size={18}/>Listings unlock after identity review</h2><p className="console-note">Complete your property and building photos first. Rooms and beds open after account, identity, payout and property approval; yearly listings then receive their own review.</p><Link href="/console/hostels/onboarding" className="console-onboarding-link">Continue identity review →</Link></section></div>}

    {detail && landlord?.kycStatus === "VERIFIED" && <div data-mobile-section="rates" data-active={mobileSection === "rates"}>
    {listings && listings.length > 0 && <nav className="hostel-workspace-task-switch" aria-label="Rate tasks"><button type="button" aria-current={rateMode === "manage" ? "page" : undefined} onClick={() => setRateMode("manage")}>Manage beds <span>{listings.length}</span></button><button type="button" aria-current={rateMode === "price" ? "page" : undefined} onClick={() => setRateMode("price")}>Set prices</button></nav>}
    <section className="console-panel" id="hostel-rates">
      <h2><SealCheck size={18}/>Beds for sale</h2>
      <div className="hostel-rate-create" data-task-active={rateMode === "price" || (listings !== null && listings.length === 0)}>
      {periods && periods.length > 0 && <div className="hostel-rate-batch"><HostelRateBatch key={detail.property.id} propertyId={detail.property.id} periods={periods} onComplete={async message => { setSaved(message); await refreshListings(detail.property.id); setRateMode("manage"); }}/><HostelSubmitBatch key={detail.property.id} propertyId={detail.property.id} periods={periods} onComplete={async message => { setSaved(message); await refreshListings(detail.property.id); }}/><span>Price or submit 1–100 numbered rooms at a time.</span></div>}
      {periods !== null && periods.length === 0
        ? <p className="console-empty">The platform has not opened an academic year yet. You can price beds as soon as it does.</p>
        : <form className="console-form" onSubmit={addListing}>
          <label>Room
            <select required value={listingDraft.roomId} onChange={(event) => setListingDraft({ ...listingDraft, roomId: event.target.value })}>
              <option value="">Choose a room…</option>
              {detail.rooms.filter(room => room.status === "ACTIVE" && room.spaces.some(space => space.status !== "RETIRED")).map(room => <option key={room.id} value={room.id}>{room.label} · {room.spaces.filter(space => space.status !== "RETIRED").length} beds · {room.bedLayout === "BUNK" ? `${room.capacity / 2} bunk unit${room.capacity === 2 ? "" : "s"}` : "separate beds"}</option>)}
            </select>
          </label>
          <label>Academic year
            <select required value={listingDraft.periodId} onChange={(event) => setListingDraft({ ...listingDraft, periodId: event.target.value })}>
              <option value="">Choose a year…</option>
              {(periods || []).map((period) => <option key={period.id} value={period.id}>{period.name}</option>)}
            </select>
          </label>
          <label>Annual rent per student bed (GH₵)
            <input type="text" inputMode="decimal" required value={listingDraft.price} onChange={(event) => setListingDraft({ ...listingDraft, price: event.target.value })} placeholder="1800.00" />
          </label>
          <button disabled={busy === "listing"}><Plus size={16}/>{busy === "listing" ? "Saving…" : "Set one rate for every bed"}</button>
        </form>}
      </div>
      <div className="hostel-rate-manage" data-task-active={rateMode === "manage" && (listings === null || listings.length > 0)}>
      {listings && listings.length > 8 && <div className="hostel-list-toolbar"><label>Find a bed<input type="search" value={listingSearch} onChange={event => { setListingSearch(event.target.value); setListingPage(0); }} placeholder="Search room, bed or year" /></label><label>Status<select value={listingStatus} onChange={event => { setListingStatus(event.target.value); setListingPage(0); }}><option value="ALL">All statuses</option><option value="DRAFT">Draft</option><option value="PENDING_REVIEW">Pending review</option><option value="APPROVED">Approved</option><option value="SUSPENDED">Suspended</option></select></label><span>{filteredListings.length} of {listings.length} beds</span></div>}
      {!listings
        ? <p className="console-empty">Loading the listings for this property…</p>
        : filteredListings.length === 0
          ? <p className="console-empty">{listings.length ? "No beds match those filters." : "No rooms priced yet. Set one annual rate per student bed for each room."}</p>
          : <table className="console-table">
            <thead><tr><th>Bed</th><th>Year</th><th>Rent per bed</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {shownListings.map((listing) => (
                <tr key={listing.id} data-expanded={expandedListingId === listing.id}>
                  <td data-label="Bed"><strong>{listing.roomLabel} · {listing.spaceLabel}</strong><small>Added {when(listing.createdAt)}</small><button type="button" className="hostel-listing-expand" aria-expanded={expandedListingId === listing.id} onClick={() => setExpandedListingId(current => current === listing.id ? "" : listing.id)}>{expandedListingId === listing.id ? "Hide actions" : "Manage this bed"}</button></td>
                  <td data-label="Academic year">{listing.periodName || "—"}</td>
                  <td data-label="Rent per bed">{cedis(listing.price)}</td>
                  <td data-label="Status">
                    <span className={badge(listing.status)}>{listing.status.replace("_", " ")}</span>
                    {listing.reviewReason && <small className="console-reason">{listing.reviewReason}</small>}
                  </td>
                  <td className="console-row-actions" data-label="Actions">
                    {listing.status === "DRAFT" && <button disabled={busy === listing.id} onClick={() => void submitListing(listing)}><PaperPlaneTilt size={15}/>Submit for review</button>}
                    {listing.status !== "SUSPENDED" && listingEdit?.id !== listing.id && <button disabled={busy === listing.id} onClick={() => setListingEdit({ id: listing.id, price: cedisInput(listing.price) })}><NotePencil size={15}/>Change room rate</button>}
                    {listingEdit?.id === listing.id && <>
                      <input
                        type="text"
                        inputMode="decimal"
                        aria-label={`New annual rent per bed in ${listing.roomLabel}`}
                        value={listingEdit.price}
                        onChange={(event) => setListingEdit({ id: listing.id, price: event.target.value })}
                      />
                      <button disabled={busy === listing.id} onClick={() => void saveListingPrice(listing)}><Check size={15}/>Save room rate</button>
                      <button disabled={busy === listing.id} onClick={() => setListingEdit(null)}>Cancel</button>
                    </>}
                    {(listing.status === "DRAFT" || listing.status === "PENDING_REVIEW") && <button disabled={busy === listing.id} onClick={() => void removeListing(listing)}><Trash size={15}/>Withdraw</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>}
      {listings && filteredListings.length > pageSize && <div className="hostel-page-controls"><span>Beds {activeListingPage * pageSize + 1}–{Math.min((activeListingPage + 1) * pageSize, filteredListings.length)} of {filteredListings.length}</span><button type="button" disabled={activeListingPage === 0} onClick={() => showListingPage(activeListingPage - 1)}>Previous</button><button type="button" disabled={(activeListingPage + 1) * pageSize >= filteredListings.length} onClick={() => showListingPage(activeListingPage + 1)}>Next</button></div>}
      <p className="console-note">
        Each bed is booked separately, but every bed in the same room has one annual rent per student for that academic year. Changing the room rate sends changed offers back to review.
      </p>
      </div>
    </section></div>}

    {detail && <div id="hostel-assistant" data-mobile-section="assistant" data-active={mobileSection === "assistant"}><HostelAiDesk key={detail.property.id} propertyId={detail.property.id} rooms={detail.rooms.map(room => ({ id: room.id, label: room.label }))} /></div>}
  </div>;
}
