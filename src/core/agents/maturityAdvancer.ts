import type { VaultAdapter } from "../../adapters/vaultAdapter";
import type { Agent, AgentRunContext, AgentRunResult } from "../coordinator/types";
import type { Database } from "../db/database";
import { upsertNotientBlock } from "../graph/frontmatterWriter";
import type { EchoGuard } from "../services/echoGuard";

type Maturity = "raw" | "adolescent" | "mature" | "synthesis-ready";

export interface MaturityAdvancerOptions {
  db: Database;
  facade: Pick<VaultAdapter, "read" | "write">;
  echoGuard: EchoGuard;
  hash: (input: string) => Promise<string>;
  freshnessHalfLifeMs?: number;
}

interface NoteRow {
  path: string;
  word_count: number;
  maturity: string;
  updated_at: number;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export class MaturityAdvancer implements Agent {
  readonly name = "maturityAdvancer" as const;
  readonly usesReasoningModel = false;

  constructor(private readonly options: MaturityAdvancerOptions) {}

  async run(context: AgentRunContext): Promise<AgentRunResult> {
    const rows = this.options.db.query<NoteRow>(
      "SELECT path, word_count, maturity, updated_at FROM notes;",
    );
    let promotions = 0;
    for (const row of rows) {
      const next = this.evaluate(row);
      if (next === row.maturity) continue;
      await this.applyPromotion(row.path, next);
      context.bus.emit({
        type: "swarm:claim_advanced",
        claimId: `note:${row.path}`,
        notePath: row.path,
        fromMaturity: row.maturity,
        toMaturity: next,
        runId: context.runId,
      });
      promotions++;
    }
    return { proposals: promotions };
  }

  private evaluate(row: NoteRow): Maturity {
    const inbound = this.countEdges(row.path, "target");
    const outbound = this.countEdges(row.path, "source");
    const ageMs = Date.now() - row.updated_at;
    if (row.maturity === "raw" && row.word_count > 0) return "adolescent";
    if (
      row.maturity === "adolescent" &&
      row.word_count >= 200 &&
      inbound + outbound >= 5 &&
      ageMs >= SEVEN_DAYS_MS
    ) {
      return "mature";
    }
    if (row.maturity === "mature" && outbound >= 10 && inbound >= 3) {
      return "synthesis-ready";
    }
    return row.maturity as Maturity;
  }

  private countEdges(path: string, side: "source" | "target"): number {
    const id = `note:${path}`;
    const column = side === "source" ? "source_id" : "target_id";
    const rows = this.options.db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM graph_edges WHERE ${column} = ? AND approved = 1;`,
      [id],
    );
    return rows[0]?.n ?? 0;
  }

  private async applyPromotion(path: string, next: Maturity): Promise<void> {
    const before = await this.options.facade.read(path);
    const freshness = computeFreshness(Date.now());
    const updated = upsertNotientBlock(before, {
      vitals: { health: 0, maturity: next, freshness },
      updated: new Date().toISOString(),
    });
    if (updated === before) return;
    const sha = await this.options.hash(updated);
    this.options.echoGuard.mark(path, sha);
    await this.options.facade.write(path, updated);
    this.options.db.run("UPDATE notes SET maturity = ? WHERE path = ?;", [next, path]);
  }
}

function computeFreshness(_now: number): number {
  return 1.0;
}
