"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { CinemaWhiteboardBlock } from "@/lib/cinema-engine/whiteboard-scene";

type GeoBlock = Extract<CinemaWhiteboardBlock, { kind: "geo" }>;

type GeoGebraApi = {
  evalCommand?: (command: string) => boolean;
  setSize?: (width: number, height: number) => void;
};

type GeoGebraApplet = {
  inject: (mountId: string) => void;
  remove?: () => void;
};

type GeoGebraConstructor = new (parameters: Record<string, unknown>, version?: string) => GeoGebraApplet;

const GEOGEBRA_SCRIPT = "https://www.geogebra.org/apps/deployggb.js";
const HEIGHT = 340;

let loader: Promise<void> | null = null;

/** The apps API is loaded once per page; every graph after the first reuses it. */
function loadGeoGebra() {
  if (typeof window === "undefined") return Promise.reject(new Error("GeoGebra draws in the browser."));
  if ((window as unknown as { GGBApplet?: unknown }).GGBApplet) return Promise.resolve();
  loader ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = GEOGEBRA_SCRIPT;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => { loader = null; reject(new Error("GeoGebra could not be loaded.")); };
    document.head.appendChild(script);
  });
  return loader;
}

/**
 * The interactive graph: a GeoGebra applet fed the commands the parser kept.
 *
 * The commands are not raw strings by the time they arrive — `geoCommandAllowed`
 * refused anything that is not an assignment or an allow-listed maths command,
 * and refused the characters that could chain one — so this component evaluates
 * a closed list rather than a model's script. The applet is loaded from
 * GeoGebra's own apps API at runtime, which keeps a multi-megabyte CAS out of
 * the room's bundle until a board actually asks for one.
 */
export function WhiteboardGeoGebra({ block }: { block: GeoBlock }) {
  const host = useRef<HTMLDivElement | null>(null);
  const api = useRef<GeoGebraApi | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const mountId = `wb-geo-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;

  useEffect(() => {
    let disposed = false;
    let applet: GeoGebraApplet | null = null;
    const commands = block.commands;
    void (async () => {
      try {
        await loadGeoGebra();
        const Constructor = (window as unknown as { GGBApplet?: GeoGebraConstructor }).GGBApplet;
        const mount = document.getElementById(mountId);
        if (disposed || !Constructor || !mount) throw new Error("GeoGebra could not be loaded.");
        applet = new Constructor({
          appName: "graphing",
          width: Math.max(280, Math.round(mount.clientWidth || 320)),
          height: HEIGHT,
          showToolBar: false,
          showAlgebraInput: false,
          showMenuBar: false,
          showResetIcon: true,
          enableLabelDrags: false,
          enableShiftDragZoom: true,
          useBrowserForJS: false,
          appletOnLoad: (loaded: GeoGebraApi) => {
            api.current = loaded;
            for (const command of commands) {
              try { loaded.evalCommand?.(command); } catch { /* one refused command paints nothing */ }
            }
            setState("ready");
          },
        }, "5.0");
        applet.inject(mountId);
      } catch {
        if (!disposed) setState("failed");
      }
    })();
    return () => {
      disposed = true;
      api.current = null;
      try { applet?.remove?.(); } catch { /* the frame is gone with the board either way */ }
    };
  }, [block, mountId]);

  useEffect(() => {
    const element = host.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const width = Math.max(280, Math.round(element.clientWidth));
      try { api.current?.setSize?.(width, HEIGHT); } catch { /* a resize that lands before the applet is ready is dropped */ }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return <figure className="wb-figure wb-geo-figure">
    <div className="wb-geo" ref={host}>
      <div className="wb-geo-frame" id={mountId} />
      {state !== "ready" && <p className="wb-geo-note">
        {state === "failed"
          ? "The interactive graph could not load on this device. The commands are listed below."
          : "Loading the interactive graph…"}
      </p>}
      {state !== "ready" && <pre className="wb-geo-script">{block.commands.join("\n")}</pre>}
    </div>
    {block.title && <figcaption>{block.title}{block.caption ? ` · ${block.caption}` : ""}</figcaption>}
    {!block.title && block.caption && <figcaption>{block.caption}</figcaption>}
  </figure>;
}
