"use client";

import { useEffect, useRef, useState } from "react";
import type { CinemaWhiteboardBlock } from "@/lib/cinema-engine/whiteboard-scene";

type ChartBlock = Extract<CinemaWhiteboardBlock, { kind: "chart" }>;

/** The room's four colours, reused by every chart so a board stays one board. */
const PALETTE = ["#1d7a5f", "#0e7490", "#d19a28", "#8a5b00"];

/**
 * The chart the model described, drawn by Plotly.
 *
 * The model never sends a trace, a layout or a callback — it sends series of
 * numbers and labels, and this component translates them into the trace shape
 * Plotly wants. There is nothing here to sanitise because there is nothing a
 * caller can put in that this code will forward: every Plotly option below is
 * written here. The library itself is a dynamic import so its ~1 MB bundle is
 * fetched only by a board that actually carries a chart.
 */
function tracesOf(block: ChartBlock) {
  return block.series.map((series, index) => {
    const color = PALETTE[index % PALETTE.length];
    const name = series.name || `Series ${index + 1}`;
    if (block.chart === "pie") {
      return {
        type: "pie",
        labels: series.x.map(String),
        values: series.y,
        name,
        hole: 0.35,
        textinfo: "label+percent",
        marker: { colors: PALETTE, line: { color: "#ffffff", width: 2 } },
      };
    }
    return {
      type: block.chart,
      x: series.x,
      y: series.y,
      name,
      ...(block.chart === "scatter" ? { mode: "markers" } : {}),
      line: { color, width: 2.4 },
      marker: { color, size: 7 },
      hovertemplate: "%{x}: %{y}<extra>" + name + "</extra>",
    };
  });
}

function layoutOf(block: ChartBlock) {
  const font = { family: "system-ui, sans-serif", size: 12, color: "#1c2b24" };
  if (block.chart === "pie") {
    return {
      margin: { l: 12, r: 12, t: 8, b: 8 },
      paper_bgcolor: "rgba(0,0,0,0)",
      font,
      showlegend: true,
      legend: { orientation: "h", y: -0.1 },
    };
  }
  const axis = { gridcolor: "#e2eae5", zerolinecolor: "#cddbd3", automargin: true, color: "#4d6357" };
  return {
    margin: { l: 48, r: 18, t: 10, b: 46 },
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "#fbfdfc",
    font,
    colorway: PALETTE,
    bargap: 0.28,
    showlegend: block.series.length > 1,
    legend: { orientation: "h", y: -0.2 },
    xaxis: { ...axis, ...(block.xLabel ? { title: { text: block.xLabel } } : {}) },
    yaxis: { ...axis, ...(block.yLabel ? { title: { text: block.yLabel } } : {}) },
  };
}

export function WhiteboardChart({ block }: { block: ChartBlock }) {
  const host = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let disposed = false;
    let plotly: typeof import("plotly.js-basic-dist-min") | null = null;
    const element = host.current;
    void (async () => {
      try {
        const plotlyModule = await import("plotly.js-basic-dist-min");
        if (disposed || !element) return;
        plotly = plotlyModule;
        await plotlyModule.newPlot(element, tracesOf(block), layoutOf(block), { displayModeBar: false, responsive: true });
      } catch {
        if (!disposed) setFailed(true);
      }
    })();
    return () => {
      disposed = true;
      if (plotly && element) {
        try { plotly.purge(element); } catch { /* the node is gone with the board either way */ }
      }
    };
  }, [block]);
  return <figure className="wb-figure wb-chart-figure">
    {failed
      ? <p className="wb-note">The chart could not be drawn on this device. The rest of the board is above and below it.</p>
      : <div className="wb-chart" ref={host} role="img" aria-label={block.title || "Chart"} />}
    {block.title && <figcaption>{block.title}</figcaption>}
  </figure>;
}
