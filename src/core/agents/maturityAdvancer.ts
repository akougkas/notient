import type { Surreal } from "surrealdb";
import YAML from "yaml";
import type { VaultAdapter } from "../../adapters/vaultAdapter";
import type { Agent, AgentRunContext, AgentRunResult } from "../coordinator/types";

type Maturity = "raw" | "adolescent" | "mature" | "synthesis-ready";

interface VitalsBlock {
  health: number;
  maturity: string;
  freshness: number;
}

export interface MaturityAdvancerOptions {
  db: Surreal;
  facade: Pick<VaultAdapter, "read" | "write">;
  freshnessHalfLifeMs?: number;
}

interface NoteRow {
  path: string;
  word_count: number;
  maturity: string | null;
  updated_at_ms: number | null;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export class MaturityAdvancer implements Agent {
  readonly name = "maturityAdvancer" as const;
  readonly usesReasoningModel = false;

  constructor(private readonly options: MaturityAdvancerOptions) {}

  async run(context: AgentRunContext): Promise<AgentRunResult> {
    const rows = await this.fetchNotes();
    let promotions = 0;
    for (const row of rows) {
      const next = await this.evaluate(row);
      const current = row.maturity ?? "raw";
      if (next === current) continue;
      await this.applyPromotion(row.path, next);
      context.bus.emit({
        type: "swarm:claim_advanced",
        claimId: `note:${row.path}`,
        notePath: row.path,
        fromMaturity: current,
        toMaturity: next,
        runId: context.runId,
      });
      promotions++;
    }
    return { proposals: promotions };
  }

  private async fetchNotes(): Promise<NoteRow[]> {
    interface Row {
      path: string;
      word_count: number;
      maturity: string | null;
      last_user_edit_at: { toDate?: () => Date } | string | null;
    }
    const [rows] = await this.options.db
      .query<[Row[]]>("SELECT path, word_count, maturity, last_user_edit_at FROM note;")
      .collect<[Row[]]>();
    return rows.map((row) => ({
      path: row.path,
      word_count: row.word_count,
      maturity: row.maturity,
      updated_at_ms: extractEpochMs(row.last_user_edit_at),
    }));
  }

  private async evaluate(row: NoteRow): Promise<Maturity> {
    const inbound = await this.countEdges(row.path, "target");
    const outbound = await this.countEdges(row.path, "source");
    const updatedAt = row.updated_at_ms ?? Date.now();
    const ageMs = Date.now() - updatedAt;
    const current = row.maturity ?? "raw";
    if (current === "raw" && row.word_count > 0) return "adolescent";
    if (
      current === "adolescent" &&
      row.word_count >= 200 &&
      inbound + outbound >= 5 &&
      ageMs >= SEVEN_DAYS_MS
    ) {
      return "mature";
    }
    if (current === "mature" && outbound >= 10 && inbound >= 3) {
      return "synthesis-ready";
    }
    return current as Maturity;
  }

  private async countEdges(path: string, side: "source" | "target"): Promise<number> {
    // wikilink.in is the source endpoint, wikilink.out is the target. Block-
    // anchored edges expose the host note as `.note`, so the union covers
    // both forms. The PENDING-STATE filter (approved AND applied) keeps the
    // count consistent with the search-consumer contract.
    const subjectField = side === "source" ? "in" : "out";
    interface CountRow {
      count: number;
    }
    const sql = `SELECT count() FROM wikilink WHERE approved = true AND applied = true AND (${subjectField}.path = $path OR ${subjectField}.note.path = $path) GROUP ALL;`;
    const [rows] = await this.options.db.query<[CountRow[]]>(sql, { path }).collect<[CountRow[]]>();
    return rows[0]?.count ?? 0;
  }

  private async applyPromotion(path: string, next: Maturity): Promise<void> {
    const before = await this.options.facade.read(path);
    const fresh = computeFreshness(Date.now());
    const updated = upsertMaturityFrontmatter(before, {
      vitals: { health: 0, maturity: next, freshness: fresh },
      updatedAt: new Date().toISOString(),
    });
    if (updated === before) return;
    await this.options.facade.write(path, updated);
    await this.options.db
      .query("UPDATE note SET maturity = $maturity WHERE path = $path;", {
        maturity: next,
        path,
      })
      .collect();
  }
}

function extractEpochMs(value: { toDate?: () => Date } | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (typeof value.toDate === "function") {
    return value.toDate().getTime();
  }
  return null;
}

function computeFreshness(_now: number): number {
  return 1.0;
}

const FRONTMATTER_FENCE = "---";

interface MaturityPatch {
  vitals: VitalsBlock;
  updatedAt: string;
}

/**
 * Inline frontmatter mutation for the maturity advancer's `notient.vitals`
 * and `notient.updated` slots. The legacy `upsertNotientBlock` helper
 * supported a richer schema (edges, summary) that is no longer used by any
 * caller; the maturity advancer is the only remaining consumer, so the
 * mutation lives here as a private helper rather than reintroducing a
 * general-purpose frontmatter writer module.
 */
function upsertMaturityFrontmatter(content: string, patch: MaturityPatch): string {
  const parts = readFrontmatter(content);
  const root = parts === null ? {} : parseYamlObject(parts.yaml);
  const notient = ensureMapping(root, "notient");
  notient.vitals = {
    health: patch.vitals.health,
    maturity: patch.vitals.maturity,
    freshness: patch.vitals.freshness,
  };
  notient.updated = patch.updatedAt;
  root.notient = notient;
  const newYaml = YAML.stringify(root).replace(/\n$/, "");
  if (parts === null) {
    return `${FRONTMATTER_FENCE}\n${newYaml}\n${FRONTMATTER_FENCE}\n${content}`;
  }
  return `${FRONTMATTER_FENCE}\n${newYaml}\n${FRONTMATTER_FENCE}\n${parts.body}`;
}

interface RawFrontmatter {
  yaml: string;
  body: string;
}

function readFrontmatter(content: string): RawFrontmatter | null {
  if (
    !content.startsWith(`${FRONTMATTER_FENCE}\n`) &&
    !content.startsWith(`${FRONTMATTER_FENCE}\r\n`)
  ) {
    return null;
  }
  const headerLen = content.startsWith(`${FRONTMATTER_FENCE}\n`)
    ? FRONTMATTER_FENCE.length + 1
    : FRONTMATTER_FENCE.length + 2;
  const closeIdx = content.indexOf(`\n${FRONTMATTER_FENCE}`, headerLen);
  if (closeIdx === -1) return null;
  const yaml = content.slice(headerLen, closeIdx + 1);
  const after = closeIdx + 1 + FRONTMATTER_FENCE.length;
  const body = content.slice(after).replace(/^\r?\n/, "");
  return { yaml, body };
}

function parseYamlObject(value: string): Record<string, unknown> {
  if (value.trim().length === 0) return {};
  const parsed = YAML.parse(value) as unknown;
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("frontmatter root must be a mapping");
  }
  return { ...(parsed as Record<string, unknown>) };
}

function ensureMapping(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = parent[key];
  if (existing === undefined || existing === null) return {};
  if (typeof existing !== "object" || Array.isArray(existing)) {
    throw new Error(`frontmatter.${key} must be a mapping`);
  }
  return { ...(existing as Record<string, unknown>) };
}
