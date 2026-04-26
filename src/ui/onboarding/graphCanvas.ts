export interface CanvasNodeInput {
  id: string;
  type: "note" | "concept" | "claim" | "question";
  label: string;
}

export interface CanvasEdgeInput {
  id: string;
  sourceId: string;
  targetId: string;
  type: string;
}

export interface CanvasNode extends CanvasNodeInput {
  x: number;
  y: number;
  bornAt: number;
}

export interface CanvasEdge extends CanvasEdgeInput {
  bornAt: number;
}

export interface GraphCanvasOptions {
  width: number;
  height: number;
}

export interface GraphCanvasCounts {
  notes: number;
  concepts: number;
  claims: number;
  questions: number;
  edges: number;
}

const NODE_COLORS: Record<CanvasNode["type"], string> = {
  note: "#9ecbff",
  concept: "#f5a97f",
  claim: "#a6da95",
  question: "#c6a0f6",
};

const PULSE_MS = 800;

export class GraphCanvasModel {
  private readonly nodes = new Map<string, CanvasNode>();
  private readonly edges: CanvasEdge[] = [];
  private nextSeed = 0;

  constructor(private readonly opts: GraphCanvasOptions) {}

  addNode(input: CanvasNodeInput): void {
    if (this.nodes.has(input.id)) return;
    const seed = this.nextSeed++;
    const { x, y } = spiralPosition(seed, this.opts.width, this.opts.height);
    this.nodes.set(input.id, { ...input, x, y, bornAt: Date.now() });
  }

  addEdge(input: CanvasEdgeInput): void {
    if (!this.nodes.has(input.sourceId) || !this.nodes.has(input.targetId)) return;
    this.edges.push({ ...input, bornAt: Date.now() });
  }

  getNode(id: string): CanvasNode | undefined {
    return this.nodes.get(id);
  }

  edgeCount(): number {
    return this.edges.length;
  }

  counts(): GraphCanvasCounts {
    const counts: GraphCanvasCounts = {
      notes: 0,
      concepts: 0,
      claims: 0,
      questions: 0,
      edges: this.edges.length,
    };
    for (const n of this.nodes.values()) {
      if (n.type === "note") counts.notes++;
      else if (n.type === "concept") counts.concepts++;
      else if (n.type === "claim") counts.claims++;
      else if (n.type === "question") counts.questions++;
    }
    return counts;
  }

  draw(ctx: CanvasRenderingContext2D, now: number): void {
    ctx.clearRect(0, 0, this.opts.width, this.opts.height);
    ctx.lineWidth = 0.6;
    ctx.strokeStyle = "rgba(180,180,200,0.25)";
    for (const edge of this.edges) {
      const a = this.nodes.get(edge.sourceId);
      const b = this.nodes.get(edge.targetId);
      if (!a || !b) continue;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    for (const node of this.nodes.values()) {
      const age = now - node.bornAt;
      const pulse = age < PULSE_MS ? 1 + (PULSE_MS - age) / PULSE_MS : 1;
      const color = NODE_COLORS[node.type];
      ctx.beginPath();
      ctx.fillStyle = color;
      ctx.shadowBlur = pulse * 6;
      ctx.shadowColor = color;
      ctx.arc(node.x, node.y, node.type === "note" ? 3.5 : 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
  }
}

export function spiralPosition(
  seed: number,
  width: number,
  height: number,
): { x: number; y: number } {
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const radius = Math.min(width, height) * 0.45;
  const t = Math.sqrt(seed + 1);
  const r = (t / Math.sqrt(seed + 50)) * radius;
  const angle = seed * goldenAngle;
  const cx = width / 2;
  const cy = height / 2;
  const x = clamp(cx + r * Math.cos(angle), 0, width);
  const y = clamp(cy + r * Math.sin(angle), 0, height);
  return { x, y };
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
