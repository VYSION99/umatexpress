"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, SlidersHorizontal } from "lucide-react";

type PlatformSetting = {
  key: string;
  kind: "toggle" | "number";
  label: string;
  summary: string;
  detail: string;
  enabled: boolean;
  value: number;
  min?: number;
  max?: number;
  source: "SETTING" | "ENV" | "DEFAULT";
  env: string;
  updatedBy: string;
  updatedAt: string;
};

const SOURCE_LABEL: Record<PlatformSetting["source"], string> = {
  SETTING: "Override set here",
  ENV: "From the environment variable",
  DEFAULT: "Built-in default · no override",
};

function sourceText(setting: PlatformSetting) {
  if (setting.source === "SETTING") {
    const when = setting.updatedAt ? new Date(setting.updatedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";
    return [SOURCE_LABEL.SETTING, setting.updatedBy, when].filter(Boolean).join(" · ");
  }
  if (setting.source === "ENV") return `${SOURCE_LABEL.ENV} ${setting.env}`;
  return `${SOURCE_LABEL.DEFAULT} · ${setting.env} takes over when it is set`;
}

/**
 * The switchboard an administrator opens to change platform-wide behaviour.
 * A switch that decides whether money moves unattended is a policy, so the
 * console owns it, the environment variable stays as the fallback, and the
 * audit log records who flipped it.
 */
export function PlatformSettings() {
  const [settings, setSettings] = useState<PlatformSetting[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    const response = await fetch("/api/console/settings", { credentials: "same-origin", cache: "no-store" });
    const data = await response.json() as { settings?: PlatformSetting[]; error?: string };
    if (!response.ok) throw new Error(data.error || "The platform settings could not be loaded.");
    setSettings(data.settings || []);
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
    queueMicrotask(() => void run(load));
  }, [load, run]);

  async function flip(setting: PlatformSetting) {
    await run(async () => {
      setBusy(setting.key);
      setNotice("");
      try {
        const response = await fetch("/api/console/settings", {
          method: "PATCH",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key: setting.key, enabled: !setting.enabled }),
        });
        const data = await response.json() as { setting?: PlatformSetting; error?: string };
        const updated = data.setting;
        if (!response.ok || !updated) throw new Error(data.error || "That switch could not be changed.");
        setSettings((current) => (current || []).map((item) => (item.key === updated.key ? updated : item)));
        setNotice(`${updated.label} is now ${updated.enabled ? "on" : "off"}. The change is recorded against your console account.`);
      } finally {
        setBusy("");
      }
    });
  }

  async function save(setting: PlatformSetting, value: number) {
    await run(async () => {
      setBusy(setting.key);
      setNotice("");
      try {
        const response = await fetch("/api/console/settings", {
          method: "PATCH",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key: setting.key, value }),
        });
        const data = await response.json() as { setting?: PlatformSetting; error?: string };
        const updated = data.setting;
        if (!response.ok || !updated) throw new Error(data.error || "That setting could not be changed.");
        setSettings((current) => (current || []).map((item) => (item.key === updated.key ? updated : item)));
        setNotice(`${updated.label} is now ${updated.value}. The change is recorded against your console account.`);
      } finally {
        setBusy("");
      }
    });
  }

  if (!settings) return <p className="console-empty"><Loader2 size={15} className="console-spin" aria-hidden /> Loading platform settings…</p>;

  return <section className="console-panel">
    <h2><SlidersHorizontal size={18} aria-hidden />Deployment switches
      <button type="button" className="console-panel-close" onClick={() => void run(load)}><RefreshCw size={14} aria-hidden />Refresh</button>
    </h2>
    {error && <div className="console-alert" role="alert">{error}</div>}
    {notice && !error && <div className="console-alert console-alert-ok" role="status">{notice}</div>}
    <ul className="console-switches">
      {settings.map((setting) => <li key={setting.key}>
        <div className="console-switch-copy">
          <strong>{setting.label}</strong>
          <span>{setting.detail}</span>
          <small className={`is-${setting.source.toLowerCase()}`}>{sourceText(setting)}</small>
        </div>
        {setting.kind === "number"
          ? <NumberSetting
            key={`${setting.key}:${setting.value}`}
            setting={setting}
            busy={busy === setting.key}
            onSave={(value) => void save(setting, value)}
          />
          : <button
            type="button"
            role="switch"
            aria-checked={setting.enabled}
            aria-label={`${setting.label}: ${setting.enabled ? "on" : "off"}`}
            className={`console-switch${setting.enabled ? " is-on" : ""}`}
            disabled={busy === setting.key}
            onClick={() => void flip(setting)}
          >
            <span aria-hidden />
            {busy === setting.key ? "Saving…" : setting.enabled ? "On" : "Off"}
          </button>}
      </li>)}
    </ul>
    <p className="console-note">Every switch here is audited against your console account. The environment variable still decides a switch until an override is saved, so a deployment that never opens this page behaves exactly as before.</p>
  </section>;
}

/** A limit reads better with its unit beside it, and the key carries it. */
const SETTING_UNITS: Array<[string, string]> = [
  ["_minutes", "minutes"],
  ["_hours", "hours"],
  // Amounts are held in the smallest unit so no rounding is ever invented.
  ["_amount", "pesewas"],
];

/** A limit is a number, not a switch: type it, save it, see the new value. */
function NumberSetting(input: {
  setting: PlatformSetting;
  busy: boolean;
  onSave: (value: number) => void;
}) {
  const { setting, busy, onSave } = input;
  const [draft, setDraft] = useState(String(setting.value));
  const unit = SETTING_UNITS.find(([suffix]) => setting.key.endsWith(suffix))?.[1] || "";
  return <form
    className="console-setting-number"
    onSubmit={(event) => {
      event.preventDefault();
      const numeric = Number(draft);
      if (Number.isFinite(numeric)) onSave(numeric);
    }}
  >
    <input
      type="number"
      inputMode="numeric"
      aria-label={`${setting.label} in ${unit || "units"}`}
      value={draft}
      min={setting.min}
      max={setting.max}
      step={1}
      disabled={busy}
      onChange={(event) => setDraft(event.target.value)}
    />
    <span>{unit}</span>
    <button type="submit" disabled={busy || !draft.trim()}>{busy ? "Saving…" : "Save"}</button>
  </form>;
}
