import type { Agent, AgentRunContext, AgentRunResult } from "../coordinator/types";
import type { Database } from "../db/database";
import { ChatJsonParseError, type LLMProvider } from "../llm/provider";
import { type DbscanPoint, dbscanCosine } from "./dbscan";

export interface SynthesizerOptions {
  db: Database;
  provider: LLMProvider;
  reasoningModel: string;
  epsilon: number;
  minClusterSize: number;
  /** Notes updated within the last N ms are eligible. 0 = all notes. */
  sinceMs: number;
  maxClusterSize?: number;
}

const SCHEMA = {
  name: "SynthesisDraft",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["title", "body", "memberPaths", "confidence"],
    properties: {
      title: { type: "string", maxLength: 120 },
      body: { type: "string", maxLength: 4000 },
      memberPaths: { type: "array", items: { type: "string" }, maxItems: 12 },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
  },
} as const;

interface SynthesisResponse {
  title: string;
  body: string;
  memberPaths: string[];
  confidence: number;
}

interface NoteCentroid {
  path: string;
  centroid: Float32Array;
}

export class Synthesizer implements Agent {
  readonly name = "synthesizer" as const;
  readonly usesReasoningModel = true;

  constructor(private readonly opts: SynthesizerOptions) {}

  async run(context: AgentRunContext): Promise<AgentRunResult> {
    const cutoff = this.opts.sinceMs > 0 ? Date.now() - this.opts.sinceMs : 0;
    const centroids = this.collectCentroids(cutoff);
    if (centroids.length < this.opts.minClusterSize) return { proposals: 0 };
    const points: DbscanPoint[] = centroids.map((c) => ({ id: c.path, v: c.centroid }));
    const clusters = dbscanCosine(points, {
      epsilon: this.opts.epsilon,
      minPoints: this.opts.minClusterSize,
    });
    let staged = 0;
    for (const cluster of clusters) {
      if (cluster.length < this.opts.minClusterSize) continue;
      const memberPaths = cluster.map((p) => p.id).slice(0, this.opts.maxClusterSize ?? 12);
      const noteSummaries = this.collectSummaries(memberPaths);
      const messages = [
        {
          role: "system" as const,
          content:
            "You are the Notient Synthesizer. Given a cluster of related notes, draft a synthesis note. Quote source notes via [[wikilinks]] in the body. Confidence < 0.6 means do not propose.",
        },
        {
          role: "user" as const,
          content: JSON.stringify({ memberPaths, summaries: noteSummaries }),
        },
      ];
      const response = await this.draftSynthesis(messages, context.signal, memberPaths);
      if (response.confidence < 0.6) continue;
      const id = `staging:synthesis:${slug(response.title)}:${Date.now()}`;
      this.opts.db.run(
        `INSERT INTO staging_nodes (id, type, label, note_path, payload, agent, confidence, created_at)
         VALUES (?,?,?,?,?,?,?,?);`,
        [
          id,
          "synthesis",
          response.title,
          null,
          JSON.stringify({
            body: response.body,
            memberPaths: response.memberPaths,
            targetPath: `0-inbox/notient-synthesis/${slug(response.title)}.md`,
          }),
          this.name,
          response.confidence,
          Date.now(),
        ],
      );
      context.bus.emit({
        type: "swarm:cluster_emerged",
        clusterId: id,
        memberNodeIds: response.memberPaths,
        centroidLabel: response.title,
        runId: context.runId,
      });
      staged++;
    }
    return { proposals: staged };
  }

  private collectCentroids(cutoff: number): NoteCentroid[] {
    const noteRows = this.opts.db.query<{ path: string }>(
      cutoff > 0 ? "SELECT path FROM notes WHERE updated_at >= ?;" : "SELECT path FROM notes;",
      cutoff > 0 ? [cutoff] : [],
    );
    const centroids: NoteCentroid[] = [];
    for (const row of noteRows) {
      const vectors = this.opts.db.query<{ vector: Uint8Array; dim: number }>(
        `SELECT e.vector AS vector, e.dim AS dim
         FROM embeddings e JOIN chunks c ON c.id = e.chunk_id
         WHERE c.note_path = ?;`,
        [row.path],
      );
      if (vectors.length === 0) continue;
      const dim = vectors[0].dim;
      const sum = new Float32Array(dim);
      for (const v of vectors) {
        const view = new Float32Array(v.vector.buffer, v.vector.byteOffset, dim);
        for (let i = 0; i < dim; i++) sum[i] += view[i];
      }
      for (let i = 0; i < dim; i++) sum[i] /= vectors.length;
      centroids.push({ path: row.path, centroid: sum });
    }
    return centroids;
  }

  private collectSummaries(paths: string[]): Array<{ path: string; head: string }> {
    return paths.map((path) => {
      const rows = this.opts.db.query<{ text: string }>(
        "SELECT text FROM chunks WHERE note_path = ? ORDER BY ord LIMIT 2;",
        [path],
      );
      return {
        path,
        head: rows
          .map((r) => r.text)
          .join("\n")
          .slice(0, 600),
      };
    });
  }

  private async draftSynthesis(
    messages: Array<{ role: "system" | "user"; content: string }>,
    signal: AbortSignal,
    memberPaths: string[],
  ): Promise<SynthesisResponse> {
    try {
      const raw = await this.opts.provider.chatJson<Partial<SynthesisResponse>>(
        messages,
        {
          model: this.opts.reasoningModel,
          temperature: 0.2,
          signal,
          maxTokens: 1500,
        },
        SCHEMA,
      );
      return normalizeSynthesis(raw, memberPaths);
    } catch (error) {
      if (error instanceof ChatJsonParseError) {
        return markdownFallback(error.raw, memberPaths);
      }
      throw error;
    }
  }
}

function normalizeSynthesis(
  raw: Partial<SynthesisResponse>,
  memberPaths: string[],
): SynthesisResponse {
  // Local LLMs (esp. quantized MoE) sometimes ignore strict json_schema and
  // omit required fields. Backfill defensively so the staging insert and the
  // downstream slug() call cannot crash the coordinator. Warn so a future
  // model regression is observable instead of silently zeroing the smoke.
  const missing: string[] = [];
  if (typeof raw.title !== "string" || raw.title.trim().length === 0) missing.push("title");
  if (typeof raw.body !== "string") missing.push("body");
  if (!Array.isArray(raw.memberPaths) || raw.memberPaths.length === 0) missing.push("memberPaths");
  if (typeof raw.confidence !== "number") missing.push("confidence");
  if (missing.length > 0) {
    console.warn(
      `[Notient][Synthesizer] chatJson payload missing required fields: ${missing.join(",")}; backfilling`,
    );
  }
  const body = typeof raw.body === "string" ? raw.body : "";
  const title =
    typeof raw.title === "string" && raw.title.trim().length > 0
      ? raw.title
      : (extractMarkdownTitle(body) ?? `Synthesis of ${memberPaths.slice(0, 2).join(", ")}`);
  const responseMembers =
    Array.isArray(raw.memberPaths) && raw.memberPaths.length > 0
      ? raw.memberPaths.filter((p): p is string => typeof p === "string")
      : memberPaths;
  const confidence = typeof raw.confidence === "number" ? raw.confidence : 0;
  return { title, body, memberPaths: responseMembers, confidence };
}

function slug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function markdownFallback(raw: string, memberPaths: string[]): SynthesisResponse {
  const body = raw.trim();
  const title = extractMarkdownTitle(body) ?? `Synthesis of ${memberPaths.slice(0, 2).join(", ")}`;
  return {
    title,
    body,
    memberPaths,
    confidence: 0.6,
  };
}

function extractMarkdownTitle(body: string): string | null {
  const match = body.match(/^\s*#\s*(?:Synthesis Note:\s*)?(.+)$/im);
  const title = match?.[1]?.trim();
  return title && title.length > 0 ? title : null;
}
