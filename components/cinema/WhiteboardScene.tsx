"use client";

import { useId } from "react";
import {
  layoutWhiteboardDiagram,
  renderMathHtml,
  type CinemaWhiteboardBlock,
  type CinemaWhiteboardLayoutNode,
  type CinemaWhiteboardScene,
} from "@/lib/cinema-engine/whiteboard-scene";

/**
 * The renderer: a scene in, pixels out.
 *
 * Nothing here trusts the scene — by the time a block arrives it has been
 * parsed and bounded by the same module on the server and again on the way in
 * from the socket — but the renderer still only ever draws text it escapes, and
 * maths goes through the small LaTeX renderer rather than an HTML string.
 *
 * Diagrams are laid out here rather than by the model: the AI says what
 * connects to what, the layout decides where that goes. That is the difference
 * between a picture and a pile.
 */

/** Labels wrap by hand; SVG has no text flow. */
function wrapLabel(label: string, maxChars = 22, maxLines = 2) {
  const words = label.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    current = word.length > maxChars ? `${word.slice(0, maxChars - 1)}…` : word;
    if (lines.length === maxLines - 1) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (!lines.length) lines.push(label.slice(0, maxChars));
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
    lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, maxChars - 1)}…`;
  }
  return lines;
}

function NodeShape({ node }: { node: CinemaWhiteboardLayoutNode }) {
  const { x, y, width, height, shape, tone } = node;
  const className = `wb-node tone-${tone}`;
  const centerY = y + height / 2;
  if (shape === "diamond") {
    return <polygon className={className} points={`${x + width / 2},${y} ${x + width},${centerY} ${x + width / 2},${y + height} ${x},${centerY}`} />;
  }
  if (shape === "hex") {
    const inset = 18;
    return <polygon className={className} points={`${x + inset},${y} ${x + width - inset},${y} ${x + width},${centerY} ${x + width - inset},${y + height} ${x + inset},${y + height} ${x},${centerY}`} />;
  }
  if (shape === "cylinder") {
    return <g className={className}>
      <rect x={x} y={y + 10} width={width} height={height - 10} rx={10} />
      <ellipse cx={x + width / 2} cy={y + 10} rx={width / 2} ry={10} />
    </g>;
  }
  return <rect className={className} x={x} y={y} width={width} height={height} rx={shape === "round" ? height / 2 : 11} />;
}

function DiagramBlock({ block }: { block: Extract<CinemaWhiteboardBlock, { kind: "diagram" }> }) {
  const unique = useId().replace(/[^A-Za-z0-9_-]/g, "");
  const arrow = `wb-arrow-${unique}`;
  const arrowBoth = `wb-arrow-both-${unique}`;
  const layout = layoutWhiteboardDiagram(block.nodes, block.edges);
  return <figure className="wb-figure">
    <svg
      className="wb-diagram"
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      role="img"
      aria-label={block.title || "Diagram"}
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <marker id={arrow} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" className="wb-arrow-head" />
        </marker>
        <marker id={arrowBoth} viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" className="wb-arrow-head" />
        </marker>
      </defs>
      {layout.edges.map((edge, index) => <g key={`edge-${index}`} className="wb-edge">
        <line
          x1={edge.x1} y1={edge.y1} x2={edge.x2} y2={edge.y2}
          className={edge.dashed ? "is-dashed" : ""}
          markerEnd={edge.arrow === "none" ? undefined : `url(#${arrow})`}
          markerStart={edge.arrow === "both" ? `url(#${arrowBoth})` : undefined}
        />
        {edge.label && <text x={edge.labelX} y={edge.labelY} className="wb-edge-label" textAnchor="middle">{edge.label}</text>}
      </g>)}
      {layout.nodes.map((node) => {
        const lines = wrapLabel(node.label);
        const startY = node.y + node.height / 2 - (lines.length - 1) * 8;
        return <g key={node.id} className="wb-node-group">
          <title>{node.label}</title>
          <NodeShape node={node} />
          {lines.map((line, index) => <text
            key={line + index}
            x={node.x + node.width / 2}
            y={startY + index * 16 + 5}
            className="wb-node-label"
            textAnchor="middle"
          >{line}</text>)}
        </g>;
      })}
    </svg>
    {block.title && <figcaption>{block.title}</figcaption>}
  </figure>;
}

function MathBlock({ block }: { block: Extract<CinemaWhiteboardBlock, { kind: "math" }> }) {
  return <figure className="wb-figure wb-math-figure">
    <div className="wb-math" dangerouslySetInnerHTML={{ __html: renderMathHtml(block.latex) }} />
    {block.caption && <figcaption>{block.caption}</figcaption>}
  </figure>;
}

export function WhiteboardScene({ scene }: { scene: CinemaWhiteboardScene }) {
  return <div className="wb-scene">
    {scene.summary && <p className="wb-summary">{scene.summary}</p>}
    {scene.unparsed && <p className="wb-note">The model answered in prose this time; the text is shown as it came.</p>}
    {scene.lab && <p className="wb-lab-note">
      <strong>Simulated lab.</strong> This walkthrough is an exercise for systems you own or are authorised to test. Running it against anything else is a crime and a disciplinary matter.
    </p>}
    {scene.blocks.map((block, index) => {
      if (block.kind === "text") return <p key={index} className="wb-text">{block.text}</p>;
      if (block.kind === "math") return <MathBlock key={index} block={block} />;
      if (block.kind === "code") return <figure key={index} className="wb-figure wb-code-figure">
        <pre className="wb-code"><code>{block.code}</code></pre>
        <figcaption>{block.caption ? `${block.caption} · ` : ""}{block.language}</figcaption>
      </figure>;
      if (block.kind === "diagram") return <DiagramBlock key={index} block={block} />;
      if (block.kind === "steps") return <section key={index} className="wb-steps">
        {block.title && <h4>{block.title}</h4>}
        <ol>
          {block.steps.map((step, position) => <li key={position}>
            <div className="wb-step-head">
              <strong>{step.title}</strong>
              {step.tag && <span className={`wb-tag ${step.tag === "LAB" ? "is-lab" : ""}`}>{step.tag}</span>}
            </div>
            {step.detail && <p>{step.detail}</p>}
          </li>)}
        </ol>
      </section>;
      return <p key={index} className={`wb-callout tone-${block.tone}`}>{block.text}</p>;
    })}
  </div>;
}
