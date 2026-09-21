/**
 * The whiteboard scene: what the AI may draw, and what the screen will accept.
 *
 * The model's reply is untrusted input. Everything here treats it that way: a
 * scene is parsed field by field, every string is bounded, every diagram edge
 * must name two nodes that exist, and anything the parser does not recognise is
 * dropped rather than rendered. A model that answers with prose instead of JSON
 * is not an error — `plainTextBoard` turns the prose into a one-block scene so
 * the room still reads the answer, and the caller says so on the board.
 *
 * The module is deliberately dependency-free: it runs in workerd, in the
 * browser and in plain Node tests, and the client imports the same types the
 * server validates against.
 */

export const CINEMA_WHITEBOARD_TOPICS = [
  "GENERAL",
  "DIAGRAM",
  "FLOWCHART",
  "MATH",
  "CODE",
  "SIMULATION",
  "SCIENCE",
  "HUMANITIES",
] as const;
export type CinemaWhiteboardTopic = (typeof CINEMA_WHITEBOARD_TOPICS)[number];

/** Bounds. A whiteboard is a summary, not a textbook. */
export const WHITEBOARD_MAX_BLOCKS = 12;
export const WHITEBOARD_MAX_NODES = 24;
export const WHITEBOARD_MAX_EDGES = 40;
export const WHITEBOARD_MAX_STEPS = 10;
export const WHITEBOARD_MAX_TEXT = 1_200;
export const WHITEBOARD_MAX_CODE = 4_000;
export const WHITEBOARD_MAX_LATEX = 400;
export const WHITEBOARD_MAX_LABEL = 90;
export const WHITEBOARD_MAX_TITLE = 160;
export const WHITEBOARD_MAX_SUMMARY = 400;

export type CinemaWhiteboardShape = "box" | "round" | "diamond" | "cylinder" | "hex";
export type CinemaWhiteboardTone = "default" | "accent" | "warn" | "good";

export type CinemaWhiteboardNode = {
  id: string;
  label: string;
  shape: CinemaWhiteboardShape;
  tone: CinemaWhiteboardTone;
  /** Optional grid hints from the model; the layout fills in the rest. */
  column?: number;
  row?: number;
};

export type CinemaWhiteboardEdge = {
  from: string;
  to: string;
  label?: string;
  dashed: boolean;
  arrow: "forward" | "both" | "none";
};

export type CinemaWhiteboardStep = { title: string; detail: string; tag?: string };

export type CinemaWhiteboardBlock =
  | { kind: "text"; text: string }
  | { kind: "math"; latex: string; caption?: string }
  | { kind: "code"; code: string; language: string; caption?: string }
  | { kind: "diagram"; title?: string; nodes: CinemaWhiteboardNode[]; edges: CinemaWhiteboardEdge[] }
  | { kind: "steps"; title?: string; lab: boolean; steps: CinemaWhiteboardStep[] }
  | { kind: "callout"; tone: "info" | "warn" | "lab"; text: string };

export type CinemaWhiteboardScene = {
  title: string;
  summary: string;
  topic: CinemaWhiteboardTopic;
  /** True when any part of the board is a simulated exercise rather than fact. */
  lab: boolean;
  blocks: CinemaWhiteboardBlock[];
  /** Set when the model's reply could not be parsed and became plain text. */
  unparsed?: boolean;
};

/** What a socket frame and a list read carry: the scene plus its row. */
export type CinemaWhiteboardView = CinemaWhiteboardScene & {
  id: string;
  roomId: string;
  requesterId: string;
  requesterName: string;
  atSeconds: number;
  createdAt: string;
};

const SHAPES = new Set<CinemaWhiteboardShape>(["box", "round", "diamond", "cylinder", "hex"]);
const TONES = new Set<CinemaWhiteboardTone>(["default", "accent", "warn", "good"]);
const ARROWS = new Set<CinemaWhiteboardEdge["arrow"]>(["forward", "both", "none"]);
const CALLOUT_TONES = new Set(["info", "warn", "lab"] as const);

/** Control characters out, whitespace collapsed; newlines are the caller's choice. */
function clean(value: unknown, max: number, options: { multiline?: boolean } = {}) {
  const text = typeof value === "string" ? value : "";
  const flattened = options.multiline
    ? text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    : text.replace(/\s+/g, " ");
  return flattened.trim().slice(0, max);
}

function boundedInteger(value: unknown, min: number, max: number): number | undefined {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return undefined;
  return Math.min(Math.max(number, min), max);
}

function parseNodes(value: unknown): CinemaWhiteboardNode[] {
  if (!Array.isArray(value)) return [];
  const nodes: CinemaWhiteboardNode[] = [];
  const seen = new Set<string>();
  for (const entry of value.slice(0, WHITEBOARD_MAX_NODES * 2)) {
    if (!entry || typeof entry !== "object") continue;
    const source = entry as Record<string, unknown>;
    const id = clean(source.id, 40).replace(/[^A-Za-z0-9_-]/g, "");
    const label = clean(source.label ?? source.text, WHITEBOARD_MAX_LABEL);
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);
    const shape = String(source.shape || "").toLowerCase() as CinemaWhiteboardShape;
    const tone = String(source.tone || "").toLowerCase() as CinemaWhiteboardTone;
    const column = boundedInteger(source.column, 0, 5);
    const row = boundedInteger(source.row, 0, 30);
    nodes.push({
      id,
      label,
      shape: SHAPES.has(shape) ? shape : "box",
      tone: TONES.has(tone) ? tone : "default",
      ...(column === undefined ? {} : { column }),
      ...(row === undefined ? {} : { row }),
    });
    if (nodes.length >= WHITEBOARD_MAX_NODES) break;
  }
  return nodes;
}

function parseEdges(value: unknown, nodes: CinemaWhiteboardNode[]): CinemaWhiteboardEdge[] {
  if (!Array.isArray(value)) return [];
  const known = new Set(nodes.map((node) => node.id));
  const edges: CinemaWhiteboardEdge[] = [];
  for (const entry of value.slice(0, WHITEBOARD_MAX_EDGES * 2)) {
    if (!entry || typeof entry !== "object") continue;
    const source = entry as Record<string, unknown>;
    const from = clean(source.from ?? source.source, 40).replace(/[^A-Za-z0-9_-]/g, "");
    const to = clean(source.to ?? source.target, 40).replace(/[^A-Za-z0-9_-]/g, "");
    // An edge to a node that does not exist is a broken picture, not a picture
    // with a missing line: the whole edge goes.
    if (!from || !to || from === to || !known.has(from) || !known.has(to)) continue;
    const label = clean(source.label, WHITEBOARD_MAX_LABEL);
    const arrow = String(source.arrow || "forward").toLowerCase() as CinemaWhiteboardEdge["arrow"];
    edges.push({
      from,
      to,
      dashed: source.dashed === true,
      arrow: ARROWS.has(arrow) ? arrow : "forward",
      ...(label ? { label } : {}),
    });
    if (edges.length >= WHITEBOARD_MAX_EDGES) break;
  }
  return edges;
}

function parseBlocks(value: unknown) {
  const blocks: CinemaWhiteboardBlock[] = [];
  let lab = false;
  if (!Array.isArray(value)) return { blocks, lab };
  for (const entry of value.slice(0, WHITEBOARD_MAX_BLOCKS * 2)) {
    if (!entry || typeof entry !== "object") continue;
    const source = entry as Record<string, unknown>;
    const kind = String(source.kind ?? source.type ?? "").toLowerCase();
    if (kind === "text" || kind === "paragraph" || kind === "note") {
      const text = clean(source.text ?? source.content, WHITEBOARD_MAX_TEXT, { multiline: true });
      if (text) blocks.push({ kind: "text", text });
    } else if (kind === "math" || kind === "formula" || kind === "equation") {
      const latex = clean(source.latex ?? source.text ?? source.content, WHITEBOARD_MAX_LATEX);
      const caption = clean(source.caption, WHITEBOARD_MAX_LABEL);
      if (latex) blocks.push({ kind: "math", latex, ...(caption ? { caption } : {}) });
    } else if (kind === "code" || kind === "snippet") {
      const code = clean(source.code ?? source.text, WHITEBOARD_MAX_CODE, { multiline: true });
      const language = clean(source.language, 24).replace(/[^A-Za-z0-9+#.-]/g, "") || "text";
      const caption = clean(source.caption, WHITEBOARD_MAX_LABEL);
      if (code) blocks.push({ kind: "code", code, language, ...(caption ? { caption } : {}) });
    } else if (kind === "diagram" || kind === "flowchart" || kind === "graph" || kind === "architecture") {
      const nodes = parseNodes(source.nodes);
      if (!nodes.length) continue;
      const edges = parseEdges(source.edges ?? source.links, nodes);
      const title = clean(source.title, WHITEBOARD_MAX_LABEL);
      blocks.push({ kind: "diagram", nodes, edges, ...(title ? { title } : {}) });
    } else if (kind === "steps" || kind === "walkthrough" || kind === "simulation") {
      const rawSteps = Array.isArray(source.steps) ? source.steps : [];
      const steps: CinemaWhiteboardStep[] = [];
      let stepLab = kind === "simulation" || source.lab === true;
      for (const rawStep of rawSteps.slice(0, WHITEBOARD_MAX_STEPS * 2)) {
        if (!rawStep || typeof rawStep !== "object") continue;
        const step = rawStep as Record<string, unknown>;
        const title = clean(step.title ?? step.label, 120);
        const detail = clean(step.detail ?? step.text, 600);
        const tag = clean(step.tag, 24).toUpperCase();
        if (!title && !detail) continue;
        if (tag === "LAB" || tag === "SIMULATED" || tag === "SAFE") stepLab = true;
        steps.push({ title: title || `Step ${steps.length + 1}`, detail, ...(tag ? { tag } : {}) });
        if (steps.length >= WHITEBOARD_MAX_STEPS) break;
      }
      if (!steps.length) continue;
      const title = clean(source.title, WHITEBOARD_MAX_LABEL);
      blocks.push({ kind: "steps", lab: stepLab, steps, ...(title ? { title } : {}) });
      if (stepLab) lab = true;
    } else if (kind === "callout" || kind === "warning" || kind === "tip") {
      const text = clean(source.text ?? source.content, 400, { multiline: true });
      const tone = String(source.tone || (kind === "warning" ? "warn" : "info")).toLowerCase();
      const resolved = CALLOUT_TONES.has(tone as "info") ? tone as "info" | "warn" | "lab" : "info";
      if (!text) continue;
      blocks.push({ kind: "callout", tone: resolved, text });
      if (resolved === "lab") lab = true;
    }
    if (blocks.length >= WHITEBOARD_MAX_BLOCKS) break;
  }
  return { blocks, lab };
}

function topicOf(value: unknown): CinemaWhiteboardTopic {
  const topic = String(value || "").toUpperCase() as CinemaWhiteboardTopic;
  return (CINEMA_WHITEBOARD_TOPICS as readonly string[]).includes(topic) ? topic : "GENERAL";
}

/**
 * The first JSON object in a reply. Models fence their output, preface it, or
 * trail an apology; the object is still in there, and a brace walk finds it
 * without a regular expression that would trip over braces in strings.
 */
export function extractJsonObject(reply: string): unknown | null {
  const text = String(reply || "");
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') { inString = true; continue; }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, index + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/** A parsed, bounded scene, or null when the reply carried no usable board. */
export function parseWhiteboardScene(reply: string): CinemaWhiteboardScene | null {
  const parsed = extractJsonObject(reply);
  if (!parsed || typeof parsed !== "object") return null;
  const source = parsed as Record<string, unknown>;
  const title = clean(source.title ?? source.heading, WHITEBOARD_MAX_TITLE);
  const summary = clean(source.summary ?? source.intro, WHITEBOARD_MAX_SUMMARY, { multiline: true });
  const { blocks, lab } = parseBlocks(source.blocks ?? source.items ?? source.sections);
  if (!blocks.length) return null;
  const topic = topicOf(source.topic);
  return {
    title: title || "Whiteboard",
    summary,
    topic,
    lab: lab || topic === "SIMULATION",
    blocks,
  };
}

/**
 * Prose that was not JSON still answers the question; show it plainly.
 *
 * A reply that *looks* like JSON but could not be parsed is a different case:
 * a truncated scene would otherwise be dumped on the board as a wall of escaped
 * braces. The room is told the scene was cut off and to ask again, which is
 * more useful than the raw text and honest about what happened.
 */
export function plainTextBoard(reply: string, question: string): CinemaWhiteboardScene {
  const trimmed = String(reply || "").trim();
  const cutOff = trimmed.startsWith("{") || trimmed.startsWith("```") || trimmed.startsWith("[");
  const answer = cutOff
    ? "The model's reply began as a board but was cut off before it could be read. Ask again — a shorter question usually fits."
    : clean(reply, WHITEBOARD_MAX_TEXT * 2, { multiline: true }) || "The model returned nothing this time. Try asking again.";
  return {
    title: clean(question, 90) || "Whiteboard",
    summary: "The model answered in prose rather than a diagram, so the answer is shown as text.",
    topic: "GENERAL",
    lab: false,
    unparsed: true,
    blocks: [{ kind: "text", text: answer }],
  };
}

export type CinemaWhiteboardLayoutNode = CinemaWhiteboardNode & {
  x: number;
  y: number;
  width: number;
  height: number;
};
export type CinemaWhiteboardLayoutEdge = CinemaWhiteboardEdge & {
  x1: number; y1: number; x2: number; y2: number; labelX: number; labelY: number;
};
export type CinemaWhiteboardLayout = {
  nodes: CinemaWhiteboardLayoutNode[];
  edges: CinemaWhiteboardLayoutEdge[];
  width: number;
  height: number;
};

const NODE_WIDTH = 176;
const NODE_HEIGHT = 56;
const COLUMN_GAP = 84;
const ROW_GAP = 38;
const PADDING = 26;

/** Where the line leaves one rectangle and meets another. */
function rectExit(centerX: number, centerY: number, towardsX: number, towardsY: number, halfWidth: number, halfHeight: number) {
  const dx = towardsX - centerX;
  const dy = towardsY - centerY;
  if (!dx && !dy) return { x: centerX, y: centerY };
  const scale = Math.min(
    dx ? halfWidth / Math.abs(dx) : Number.POSITIVE_INFINITY,
    dy ? halfHeight / Math.abs(dy) : Number.POSITIVE_INFINITY,
  );
  return { x: centerX + dx * scale, y: centerY + dy * scale };
}

/**
 * A layered layout, computed rather than drawn by the model.
 *
 * Models are good at saying what connects to what and bad at coordinates, so
 * the scene carries edges and optional grid hints and the layout does the rest:
 * longest-path layering left to right, discovery order within a layer, and
 * explicit `column`/`row` when the model did have a picture in mind. Cycles are
 * not rejected — a flow chart may legitimately loop — they are given a layer
 * and drawn like anything else.
 */
export function layoutWhiteboardDiagram(
  nodes: CinemaWhiteboardNode[],
  edges: CinemaWhiteboardEdge[],
): CinemaWhiteboardLayout {
  const index = new Map(nodes.map((node, position) => [node.id, position]));
  const outgoing = new Map<string, CinemaWhiteboardEdge[]>();
  const incomingCount = new Map<string, number>();
  for (const node of nodes) {
    outgoing.set(node.id, []);
    incomingCount.set(node.id, 0);
  }
  for (const edge of edges) {
    if (!index.has(edge.from) || !index.has(edge.to)) continue;
    outgoing.get(edge.from)?.push(edge);
    incomingCount.set(edge.to, (incomingCount.get(edge.to) ?? 0) + 1);
  }

  const layer = new Map<string, number>();
  const queue = nodes.filter((node) => (incomingCount.get(node.id) ?? 0) === 0).map((node) => node.id);
  for (const id of queue) layer.set(id, 0);
  if (!queue.length && nodes.length) { layer.set(nodes[0].id, 0); queue.push(nodes[0].id); }
  for (let head = 0; head < queue.length; head += 1) {
    const id = queue[head];
    for (const edge of outgoing.get(id) ?? []) {
      const next = (layer.get(id) ?? 0) + 1;
      if (next > (layer.get(edge.to) ?? -1)) layer.set(edge.to, next);
      if (!queue.includes(edge.to)) queue.push(edge.to);
    }
  }
  // A cycle leaves nodes unvisited; they belong beside their first predecessor.
  for (const node of nodes) {
    if (layer.has(node.id)) continue;
    const predecessor = edges.find((edge) => edge.to === node.id && layer.has(edge.from));
    layer.set(node.id, predecessor ? (layer.get(predecessor.from) ?? 0) + 1 : 0);
  }

  const columnOf = (node: CinemaWhiteboardNode) => node.column ?? Math.min(layer.get(node.id) ?? 0, 5);
  const occupied = new Set<string>();
  const rows = new Map<string, number>();
  for (const node of nodes) {
    const column = columnOf(node);
    if (node.row !== undefined) {
      rows.set(node.id, node.row);
      occupied.add(`${column}:${node.row}`);
    }
  }
  const nextFreeRow = (column: number) => {
    let row = 0;
    while (occupied.has(`${column}:${row}`)) row += 1;
    occupied.add(`${column}:${row}`);
    return row;
  };
  for (const node of nodes) {
    if (rows.has(node.id)) continue;
    rows.set(node.id, nextFreeRow(columnOf(node)));
  }

  const placed: CinemaWhiteboardLayoutNode[] = nodes.map((node) => {
    const column = columnOf(node);
    const row = rows.get(node.id) ?? 0;
    return {
      ...node,
      x: PADDING + column * (NODE_WIDTH + COLUMN_GAP),
      y: PADDING + row * (NODE_HEIGHT + ROW_GAP),
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    };
  });
  const at = new Map(placed.map((node) => [node.id, node]));
  const laidOutEdges: CinemaWhiteboardLayoutEdge[] = [];
  for (const edge of edges) {
    const from = at.get(edge.from);
    const to = at.get(edge.to);
    if (!from || !to) continue;
    const fromCenter = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
    const toCenter = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
    const start = rectExit(fromCenter.x, fromCenter.y, toCenter.x, toCenter.y, from.width / 2, from.height / 2);
    const end = rectExit(toCenter.x, toCenter.y, fromCenter.x, fromCenter.y, to.width / 2, to.height / 2);
    laidOutEdges.push({
      ...edge,
      x1: start.x, y1: start.y, x2: end.x, y2: end.y,
      labelX: (start.x + end.x) / 2,
      labelY: (start.y + end.y) / 2 - 4,
    });
  }
  const maxX = placed.reduce((largest, node) => Math.max(largest, node.x + node.width), 0);
  const maxY = placed.reduce((largest, node) => Math.max(largest, node.y + node.height), 0);
  return { nodes: placed, edges: laidOutEdges, width: maxX + PADDING, height: maxY + PADDING };
}

const MATH_SYMBOLS: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", Delta: "Δ", epsilon: "ε", theta: "θ", lambda: "λ",
  mu: "μ", pi: "π", rho: "ρ", sigma: "σ", Sigma: "Σ", tau: "τ", phi: "φ", omega: "ω", Omega: "Ω",
  times: "×", cdot: "·", div: "÷", pm: "±", le: "≤", leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠",
  approx: "≈", to: "→", rightarrow: "→", leftarrow: "←", infty: "∞", sum: "∑", prod: "∏",
  int: "∫", partial: "∂", nabla: "∇", sqrt: "√", in: "∈", notin: "∉", subset: "⊂", cup: "∪", cap: "∩",
  forall: "∀", exists: "∃", land: "∧", lor: "∨", neg: "¬",
};

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The matching `}` for the `{` at `open`, or -1. */
function matchingBrace(text: string, open: number) {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function renderMathBody(latex: string, depth: number): string {
  if (depth > 5 || !latex) return escapeHtml(latex);
  let html = "";
  let index = 0;
  const readGroup = () => {
    if (latex[index] === "{") {
      const close = matchingBrace(latex, index);
      if (close > 0) {
        const inner = latex.slice(index + 1, close);
        index = close + 1;
        return renderMathBody(inner, depth + 1);
      }
    }
    const character = latex[index] ?? "";
    index += 1;
    return renderMathBody(character, depth + 1);
  };
  while (index < latex.length) {
    const character = latex[index];
    if (character === "\\") {
      const match = /^\\([A-Za-z]+)/.exec(latex.slice(index));
      if (match && match[1] === "frac") {
        index += match[0].length;
        const numerator = readGroup();
        const denominator = readGroup();
        html += `<span class="cinema-math-frac"><span class="cinema-math-num">${numerator}</span><span class="cinema-math-den">${denominator}</span></span>`;
        continue;
      }
      if (match && match[1] === "sqrt") {
        index += match[0].length;
        html += `<span class="cinema-math-sqrt">√<span class="cinema-math-radicand">${readGroup()}</span></span>`;
        continue;
      }
      if (match && MATH_SYMBOLS[match[1]]) {
        html += MATH_SYMBOLS[match[1]];
        index += match[0].length;
        continue;
      }
      if (match) {
        html += escapeHtml(match[1]);
        index += match[0].length;
        continue;
      }
      index += 1;
      continue;
    }
    if (character === "^" || character === "_") {
      index += 1;
      const tag = character === "^" ? "sup" : "sub";
      html += `<${tag}>${readGroup()}</${tag}>`;
      continue;
    }
    html += escapeHtml(character);
    index += 1;
  }
  return html;
}

/**
 * LaTeX to a small, safe subset of HTML.
 *
 * The board is written by a model and shown to a room, so the string is escaped
 * before any substitution: `\frac`, `\sqrt`, `^` and `_` become real layout,
 * Greek and operator commands become their glyphs, and everything else is
 * shown as written. There is no evaluation and no raw HTML.
 */
export function renderMathHtml(latex: string): string {
  return renderMathBody(clean(latex, WHITEBOARD_MAX_LATEX), 0);
}
