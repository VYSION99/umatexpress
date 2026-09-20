"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { BadgeCheck, BedDouble, Building2, Check, DoorOpen, MapPin, PencilLine, Plus, RotateCcw, Send, ShieldCheck, Trash2 } from "lucide-react";
import { ConsoleSessionGate } from "@/components/admin/ConsoleSessionGate";
import { ConsoleShell } from "@/components/console/ConsoleShell";
import { ConsoleUnavailable } from "@/components/console/ConsoleUnavailable";
import { HostelReviewQueue } from "@/components/console/hostel/HostelReviewQueue";

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
  utilitiesFee: number; amenities: string; status: string; spaces: Space[];
};

type PropertyDetail = { property: Property; rooms: Room[] };
type Period = { id: string; name: string; startsOn: string; endsOn: string };
type Listing = {
  id: string; spaceId: string; periodId: string; price: number; status: string;
  reviewReason: string; submittedAt: string; reviewedAt: string; createdAt: string;
  propertyId: string; propertyName: string; roomLabel: string; spaceLabel: string;
  periodName: string; periodActive: boolean;
};
type RoomDraft = { label: string; capacity: string; utilitiesFee: string; amenities: string };
type OpenPanel = { kind: "edit" | "beds"; roomId: string } | null;

const EMPTY_ROOM: RoomDraft = { label: "", capacity: "2", utilitiesFee: "0", amenities: "" };
/** The engine holds a room to six beds; the form can only offer what it allows. */
const BED_COUNTS = ["1", "2", "3", "4", "5", "6"];

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
  const [listingDraft, setListingDraft] = useState({ spaceId: "", periodId: "", price: "" });
  const [listingEdit, setListingEdit] = useState<{ id: string; price: string } | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/console/hostel/properties", { credentials: "same-origin", cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Your hostel workspace could not be loaded.");
      setLandlord(data.landlord);
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
    setListings(data.listings || []);
  }, []);

  async function openProperty(property: Property) {
    setBusy(`open:${property.id}`); setError(""); setSaved("");
    setPanels(null); setRoomEdit(null); setListings(null); setListingEdit(null);
    try {
      await refreshDetail(property.id);
      await refreshListings(property.id);
      setPropertyEdit(null);
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : "That property could not be opened.");
    } finally {
      setBusy("");
    }
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
      setSaved(`${property.name} saved as a draft. Add its rooms and beds below.`);
      await openProperty(property);
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
        }),
      });
      const room = data.room as Room;
      setRoomDraft({ ...EMPTY_ROOM });
      setSaved(`${room.label} added with ${room.spaces.length} ${room.spaces.length === 1 ? "bed" : "beds"}.`);
      await refreshDetail(detail.property.id);
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
      const data = await request("/api/console/hostel/listings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          spaceId: listingDraft.spaceId,
          periodId: listingDraft.periodId,
          price: toPesewas(listingDraft.price),
        }),
      });
      const listing = data.listing as Listing;
      setListingDraft({ spaceId: "", periodId: listing.periodId, price: "" });
      setSaved(`${listing.roomLabel} · ${listing.spaceLabel} is priced for ${listing.periodName}. Submit it when it is right.`);
      await refreshListings(detail.property.id);
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
    setBusy(listing.id); setError(""); setSaved("");
    try {
      const data = await request(`/api/console/hostel/listings/${encodeURIComponent(listing.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ price: toPesewas(listingEdit.price) }),
      });
      setListingEdit(null);
      setSaved(data.listing.status === "DRAFT" && listing.status !== "DRAFT"
        ? "Rent saved. The bed is back in draft, so submit it again for review."
        : "Rent saved.");
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

  return <>
    {error && <div className="console-alert" role="alert">{error}</div>}
    {saved && !error && <div className="console-alert console-alert-ok" role="status">{saved}</div>}

    <section className="console-panel">
      <h2><ShieldCheck size={18}/>Landlord account
        {landlord && <span className={badge(landlord.kycStatus === "VERIFIED" ? "APPROVED" : landlord.kycStatus)}>KYC {landlord.kycStatus}</span>}
      </h2>
      {landlord && <p className="console-note">
        <strong>{landlord.organization || landlord.name}</strong> · {landlord.phone} · {landlord.email}
      </p>}
      <p className="console-note">
        Your account is active and you can build straight away. Verification and payout details arrive before any money moves.
      </p>
    </section>

    <section className="console-panel">
      <h2><Building2 size={18}/>Add a property</h2>
      <form className="console-form" onSubmit={addProperty}>
        <label>Property name
          <input type="text" required minLength={2} maxLength={80} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Green View Hostel" />
        </label>
        <label>Address
          <input type="text" required minLength={3} maxLength={160} value={draft.address} onChange={(event) => setDraft({ ...draft, address: event.target.value })} placeholder="Near UMaT main gate, Tarkwa" />
        </label>
        <label>Latitude (optional)
          <input type="text" inputMode="decimal" value={draft.latitude} onChange={(event) => setDraft({ ...draft, latitude: event.target.value })} placeholder="5.3009" />
        </label>
        <label>Longitude (optional)
          <input type="text" inputMode="decimal" value={draft.longitude} onChange={(event) => setDraft({ ...draft, longitude: event.target.value })} placeholder="-1.9897" />
        </label>
        <label className="console-check-field">
          <input type="checkbox" checked={draft.utilitiesEnabled} onChange={(event) => setDraft({ ...draft, utilitiesEnabled: event.target.checked })} /> Charge a utilities fee per bed
        </label>
        <button disabled={busy === "property"}><Plus size={16}/>{busy === "property" ? "Saving…" : "Save property"}</button>
      </form>
      <p className="console-note">
        <MapPin size={13}/> Latitude and longitude place the property on the student map. You can add them later; without them the property still lists.
      </p>
    </section>

    <section className="console-panel">
      <h2><BedDouble size={18}/>Your properties</h2>
      {!properties
        ? <p className="console-empty">Loading your properties…</p>
        : properties.length === 0
          ? <p className="console-empty">No properties yet. Add your first building above.</p>
          : <table className="console-table">
            <thead><tr><th>Property</th><th>Location</th><th>Utilities</th><th>Status</th><th>Added</th><th></th></tr></thead>
            <tbody>
              {properties.map((property) => (
                <tr key={property.id}>
                  <td><span>{property.name}</span><small>{property.address || "No address yet"}</small></td>
                  <td>{property.latitude !== null && property.longitude !== null ? `${property.latitude.toFixed(4)}, ${property.longitude.toFixed(4)}` : "Not pinned"}</td>
                  <td>{property.utilitiesEnabled ? "Fee per bed" : "Rent only"}</td>
                  <td><span className={badge(property.status)}>{property.status.replace("_", " ")}</span></td>
                  <td>{when(property.createdAt)}</td>
                  <td className="console-row-actions">
                    <button disabled={busy === `open:${property.id}`} onClick={() => void openProperty(property)}>
                      <DoorOpen size={15}/>{detail?.property.id === property.id ? "Rooms & beds" : "Open"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>}
      <p className="console-note">
        A property stays a draft while you build it. Add every room and bed-space now — you only upload photos and submit for review when the building is complete.
      </p>
    </section>

    {detail && <section className="console-panel">
      <h2><Building2 size={18}/>{detail.property.name}
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
          <PencilLine size={14}/>{propertyEdit ? "Close editor" : "Edit details"}
        </button>
      </h2>
      <p className="console-note">
        {detail.property.address || "No address yet"} · {detail.property.utilitiesEnabled ? "Utilities fee per bed applies" : "Rent only"} · {detail.rooms.length} {detail.rooms.length === 1 ? "room" : "rooms"}
      </p>

      {propertyEdit && <form className="console-form" onSubmit={savePropertyEdit}>
        <label>Property name
          <input type="text" required minLength={2} maxLength={80} value={propertyEdit.name} onChange={(event) => setPropertyEdit({ ...propertyEdit, name: event.target.value })} />
        </label>
        <label>Address
          <input type="text" required minLength={3} maxLength={160} value={propertyEdit.address} onChange={(event) => setPropertyEdit({ ...propertyEdit, address: event.target.value })} />
        </label>
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
    </section>}

    {detail && <section className="console-panel">
      <h2><Plus size={18}/>Add a room to {detail.property.name}</h2>
      <form className="console-form" onSubmit={addRoom}>
        <label>Room name
          <input type="text" required minLength={1} maxLength={24} value={roomDraft.label} onChange={(event) => setRoomDraft({ ...roomDraft, label: event.target.value })} placeholder="Room 3" />
        </label>
        <label>Beds in the room
          <select value={roomDraft.capacity} onChange={(event) => setRoomDraft({ ...roomDraft, capacity: event.target.value })}>
            {BED_COUNTS.map((count) => <option key={count} value={count}>{count}</option>)}
          </select>
        </label>
        <label>Utilities fee per bed (GH₵)
          <input type="text" inputMode="decimal" value={roomDraft.utilitiesFee} onChange={(event) => setRoomDraft({ ...roomDraft, utilitiesFee: event.target.value })} placeholder="0.00" />
        </label>
        <label>Amenities
          <input type="text" maxLength={200} value={roomDraft.amenities} onChange={(event) => setRoomDraft({ ...roomDraft, amenities: event.target.value })} placeholder="AC, wardrobe, private bath" />
        </label>
        <button disabled={busy === "room"}><Plus size={16}/>{busy === "room" ? "Saving…" : "Add room & beds"}</button>
      </form>
      <p className="console-note">
        Each bed is created for you and named <strong>Bed A</strong> upwards, so a student books a bed, never just a room.
      </p>
    </section>}

    {detail && <section className="console-panel">
      <h2><BedDouble size={18}/>Rooms and beds</h2>
      {detail.rooms.length === 0
        ? <p className="console-empty">No rooms yet. Add the first one above.</p>
        : <table className="console-table">
          <thead><tr><th>Room</th><th>Beds</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {detail.rooms.map((room) => {
              const live = room.spaces.filter((space) => space.status !== "RETIRED");
              return <tr key={room.id}>
                <td>
                  <strong>{room.label}</strong>
                  <small>Sleeps {room.capacity} · {room.utilitiesFee > 0 ? `${cedis(room.utilitiesFee)} per bed` : "Utilities included"}</small>
                  {room.amenities && <small>{room.amenities}</small>}
                </td>
                <td>
                  <span>{live.length} live {live.length === 1 ? "bed" : "beds"}</span>
                  <small>{room.spaces.map((space) => space.label).join(", ") || "No beds yet"}</small>
                </td>
                <td><span className={badge(room.status)}>{room.status}</span></td>
                <td className="console-row-actions">
                  <button disabled={busy === "room-edit"} onClick={() => {
                    setPanels(null);
                    setRoomEdit({
                      id: room.id,
                      label: room.label,
                      capacity: String(room.capacity),
                      utilitiesFee: cedisInput(room.utilitiesFee),
                      amenities: room.amenities,
                      status: room.status,
                    });
                    setError(""); setSaved("");
                  }}><PencilLine size={15}/>Edit</button>
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
      <p className="console-note">
        Shrinking a room retires its highest beds for you; growing it adds more. A bed with a live listing is never retired behind your back.
      </p>
    </section>}

    {detail && roomEdit && <section className="console-panel">
      <h2><PencilLine size={18}/>Edit {roomEdit.label}
        <button className="console-panel-close" onClick={() => setRoomEdit(null)}>Close</button>
      </h2>
      <form className="console-form" onSubmit={saveRoomEdit}>
        <label>Room name
          <input type="text" required minLength={1} maxLength={24} value={roomEdit.label} onChange={(event) => setRoomEdit({ ...roomEdit, label: event.target.value })} />
        </label>
        <label>Beds in the room
          <select value={roomEdit.capacity} onChange={(event) => setRoomEdit({ ...roomEdit, capacity: event.target.value })}>
            {BED_COUNTS.map((count) => <option key={count} value={count}>{count}</option>)}
          </select>
        </label>
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
                <td>
                  <input
                    type="text"
                    aria-label={`Name for ${space.label}`}
                    maxLength={24}
                    value={typed}
                    onChange={(event) => setBedNames({ ...bedNames, [space.id]: event.target.value })}
                  />
                </td>
                <td><span className={badge(space.status)}>{space.status}</span></td>
                <td className="console-row-actions">
                  <button disabled={busy === space.id || typed.trim() === space.label || typed.trim().length === 0} onClick={() => void saveBedName(space)}>
                    <Check size={15}/>Save name
                  </button>
                  {space.status === "RETIRED"
                    ? <button disabled={busy === space.id} onClick={() => void setBedStatus(space, "AVAILABLE")}><RotateCcw size={15}/>Restore</button>
                    : <button disabled={busy === space.id} onClick={() => void setBedStatus(space, "RETIRED")}><Trash2 size={15}/>Retire</button>}
                </td>
              </tr>;
            })}
          </tbody>
        </table>}
      <p className="console-note">
        Rename a bed to match the room — <strong>Bed A</strong>, <strong>Top bunk</strong>, whatever a student sees. Retiring a bed keeps it on old records but hides it from new bookings.
      </p>
    </section>}

    {detail && <section className="console-panel">
      <h2><BadgeCheck size={18}/>Beds for sale</h2>
      {periods !== null && periods.length === 0
        ? <p className="console-empty">The platform has not opened an academic year yet. You can price beds as soon as it does.</p>
        : <form className="console-form" onSubmit={addListing}>
          <label>Bed
            <select required value={listingDraft.spaceId} onChange={(event) => setListingDraft({ ...listingDraft, spaceId: event.target.value })}>
              <option value="">Choose a bed…</option>
              {detail.rooms.flatMap((room) => room.spaces
                .filter((space) => space.status !== "RETIRED")
                .map((space) => {
                  const taken = (listings || []).some((listing) => listing.spaceId === space.id && listing.periodId === listingDraft.periodId);
                  return <option key={space.id} value={space.id} disabled={taken}>
                    {room.label} · {space.label}{taken ? " (already listed)" : ""}
                  </option>;
                }))}
            </select>
          </label>
          <label>Academic year
            <select required value={listingDraft.periodId} onChange={(event) => setListingDraft({ ...listingDraft, periodId: event.target.value })}>
              <option value="">Choose a year…</option>
              {(periods || []).map((period) => <option key={period.id} value={period.id}>{period.name}</option>)}
            </select>
          </label>
          <label>Rent for the year (GH₵)
            <input type="text" inputMode="decimal" required value={listingDraft.price} onChange={(event) => setListingDraft({ ...listingDraft, price: event.target.value })} placeholder="1800.00" />
          </label>
          <button disabled={busy === "listing"}><Plus size={16}/>{busy === "listing" ? "Saving…" : "Price the bed"}</button>
        </form>}
      {!listings
        ? <p className="console-empty">Loading the listings for this property…</p>
        : listings.length === 0
          ? <p className="console-empty">No beds priced yet. A listing is one bed for one academic year.</p>
          : <table className="console-table">
            <thead><tr><th>Bed</th><th>Year</th><th>Rent</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {listings.map((listing) => (
                <tr key={listing.id}>
                  <td><strong>{listing.roomLabel} · {listing.spaceLabel}</strong><small>Added {when(listing.createdAt)}</small></td>
                  <td>{listing.periodName || "—"}</td>
                  <td>{cedis(listing.price)}</td>
                  <td>
                    <span className={badge(listing.status)}>{listing.status.replace("_", " ")}</span>
                    {listing.reviewReason && <small className="console-reason">{listing.reviewReason}</small>}
                  </td>
                  <td className="console-row-actions">
                    {listing.status === "DRAFT" && <button disabled={busy === listing.id} onClick={() => void submitListing(listing)}><Send size={15}/>Submit for review</button>}
                    {listing.status !== "SUSPENDED" && listingEdit?.id !== listing.id && <button disabled={busy === listing.id} onClick={() => setListingEdit({ id: listing.id, price: cedisInput(listing.price) })}><PencilLine size={15}/>Change rent</button>}
                    {listingEdit?.id === listing.id && <>
                      <input
                        type="text"
                        inputMode="decimal"
                        aria-label={`New rent for ${listing.spaceLabel}`}
                        value={listingEdit.price}
                        onChange={(event) => setListingEdit({ id: listing.id, price: event.target.value })}
                      />
                      <button disabled={busy === listing.id} onClick={() => void saveListingPrice(listing)}><Check size={15}/>Save rent</button>
                      <button disabled={busy === listing.id} onClick={() => setListingEdit(null)}>Cancel</button>
                    </>}
                    {(listing.status === "DRAFT" || listing.status === "PENDING_REVIEW") && <button disabled={busy === listing.id} onClick={() => void removeListing(listing)}><Trash2 size={15}/>Withdraw</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>}
      <p className="console-note">
        Students only see a bed after review approves it. Changing a price sends an approved bed back to review — a cheaper price is still a different offer.
      </p>
    </section>}
  </>;
}
