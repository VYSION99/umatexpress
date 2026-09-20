"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Check, Loader2, PackagePlus, PencilLine, X } from "lucide-react";
import { cedis } from "@/components/campusRide/hostel/format";

type Plugin = {
  id: string; code: string; name: string; description: string; category: string;
  price: number; suggestedResidentPrice: number; active: boolean;
};

const CATEGORIES = ["UTILITY", "SERVICE", "COMFORT", "SECURITY"] as const;
const EMPTY = { code: "", name: "", description: "", category: "SERVICE", price: "", suggestedResidentPrice: "", active: true };

/**
 * The platform's hostel service catalogue: what landlords may switch on for
 * their residents, what the platform charges them for it, and the resident
 * price every landlord is offered as a default.
 *
 * The platform fee belongs to UMaTeXPRESS and is the same for everyone; the
 * resident price is only a suggestion, because a hostel in Madina and one in
 * Ayeduase do not sell water at the same price.
 */
export function PluginCatalogue() {
  const [plugins, setPlugins] = useState<Plugin[] | null>(null);
  const [draft, setDraft] = useState({ ...EMPTY });
  const [editing, setEditing] = useState<string>("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    const response = await fetch("/api/console/hostel/plugins/catalogue", { credentials: "same-origin", cache: "no-store" });
    const data = await response.json() as { catalogue?: Plugin[]; error?: string };
    if (!response.ok) throw new Error(data.error || "The catalogue could not be loaded.");
    setPlugins(data.catalogue || []);
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      load().catch((loadError) => setError(loadError instanceof Error ? loadError.message : "The catalogue could not be loaded."));
    });
  }, [load]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setNotice("");
    setBusy("save");
    try {
      const response = await fetch("/api/console/hostel/plugins/catalogue", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(editing ? { pluginId: editing } : { code: draft.code }),
          name: draft.name,
          description: draft.description,
          category: draft.category,
          price: Math.round(Number(draft.price || 0) * 100),
          suggestedResidentPrice: Math.round(Number(draft.suggestedResidentPrice || 0) * 100),
          active: draft.active,
        }),
      });
      const data = await response.json() as { plugin?: Plugin; error?: string };
      if (!response.ok) throw new Error(data.error || "That plugin could not be saved.");
      setNotice(editing ? `${data.plugin?.name || "Plugin"} updated.` : `${data.plugin?.name || "Plugin"} added to the catalogue.`);
      setDraft({ ...EMPTY });
      setEditing("");
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "That plugin could not be saved.");
    } finally {
      setBusy("");
    }
  }

  function edit(plugin: Plugin) {
    setEditing(plugin.id);
    setNotice("");
    setError("");
    setDraft({
      code: plugin.code,
      name: plugin.name,
      description: plugin.description,
      category: plugin.category,
      price: (plugin.price / 100).toFixed(2),
      suggestedResidentPrice: (plugin.suggestedResidentPrice / 100).toFixed(2),
      active: plugin.active,
    });
  }

  return <section className="console-panel">
    <h2><PackagePlus size={18} aria-hidden />Service catalogue
      {editing && <button type="button" className="console-panel-close" onClick={() => { setEditing(""); setDraft({ ...EMPTY }); }}><X size={14} aria-hidden />Cancel edit</button>}
    </h2>
    <p className="console-note">
      Each service is charged to the landlord once per academic year, on top of the 9% commission on bed payments. The resident
      price is the default a landlord starts from and may change; the platform fee is what the platform earns.
    </p>
    {error && <div className="console-alert" role="alert">{error}</div>}
    {notice && !error && <div className="console-alert console-alert-ok" role="status">{notice}</div>}

    <form className="console-form" onSubmit={submit}>
      <label>Code
        <input type="text" value={draft.code} onChange={(event) => setDraft({ ...draft, code: event.target.value.toUpperCase() })} maxLength={24} placeholder="WATER" disabled={Boolean(editing)} />
      </label>
      <label>Name
        <input type="text" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} maxLength={80} placeholder="Water supply" />
      </label>
      <label>Category
        <select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })}>
          {CATEGORIES.map((category) => <option key={category} value={category}>{category}</option>)}
        </select>
      </label>
      <label>Platform fee (GH₵ a year)
        <input type="text" inputMode="decimal" value={draft.price} onChange={(event) => setDraft({ ...draft, price: event.target.value })} placeholder="0.00" />
      </label>
      <label>Suggested resident price (GH₵)
        <input type="text" inputMode="decimal" value={draft.suggestedResidentPrice} onChange={(event) => setDraft({ ...draft, suggestedResidentPrice: event.target.value })} placeholder="0.00" />
      </label>
      <label className="console-check-field">On sale
        <input type="checkbox" checked={draft.active} onChange={(event) => setDraft({ ...draft, active: event.target.checked })} />
      </label>
      <label className="console-field-wide">Description
        <textarea value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} maxLength={400} rows={2} placeholder="What the resident gets." />
      </label>
      <button type="submit" disabled={busy === "save" || !draft.name.trim() || (!editing && !draft.code.trim())}>
        {busy === "save" ? <Loader2 size={15} className="console-spin" aria-hidden /> : <Check size={15} aria-hidden />}
        {editing ? "Save changes" : "Add to catalogue"}
      </button>
    </form>

    {!plugins
      ? <p className="console-empty"><Loader2 size={15} className="console-spin" aria-hidden /> Loading the catalogue…</p>
      : <table className="console-table">
        <thead><tr><th>Service</th><th>Category</th><th>Platform fee</th><th>Resident default</th><th>State</th><th></th></tr></thead>
        <tbody>
          {plugins.map((plugin) => <tr key={plugin.id}>
            <td><strong>{plugin.name}</strong><small>{plugin.code}{plugin.description ? ` · ${plugin.description}` : ""}</small></td>
            <td>{plugin.category}</td>
            <td><strong>{cedis(plugin.price)}</strong><small>a year</small></td>
            <td>{cedis(plugin.suggestedResidentPrice)}</td>
            <td><span className={`console-badge console-badge-${plugin.active ? "approved" : "draft"}`}>{plugin.active ? "ON SALE" : "HIDDEN"}</span></td>
            <td className="console-row-actions">
              <button type="button" onClick={() => edit(plugin)}><PencilLine size={15} aria-hidden />Edit</button>
            </td>
          </tr>)}
        </tbody>
      </table>}
  </section>;
}
