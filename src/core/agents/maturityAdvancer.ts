import { DateTime, type Surreal } from "surrealdb";
import YAML from "yaml";
import type { VaultAdapter } from "../../adapters/vaultAdapter";
import type { Agent, AgentRunContext, AgentRunResult } from "../coordinator/types";
import type { Maturity } from "../vitals/types";

export interface MaturityAdvancerSettings {
  /**
   * When false (the default in `settings.vitals`), promotions update
   * `note.maturity` in SurrealDB only. The agent never rewrites vault files
   * behind the user's back.
   */
  writeToFrontmatter: boolean;
}

export interface MaturityAdvancerOptions {
  db: Surreal;
  facade: Pick<VaultAdapter, "read" | "writeIfUnchanged">;
  /** Live view of the validated `settings.vitals` product configuration. */
  settings: () => MaturityAdvancerSettings;
}

/**
 * Hard cap on promotions per tick. Promotions are idempotent and the agent
 * runs on every `idle-30m`, so the cap spreads a large cold-vault backlog
 * across ticks instead of rewriting every promoted note at once.
 */
export const MAX_PROMOTIONS_PER_TICK = 50;

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** Approved-and-applied wikilink count, both direct and block-anchored. */
function edgeCountExpr(direction: "in" | "out"): string {
  const arrow = direction === "out" ? "->wikilink" : "<-wikilink";
  const filter = "[WHERE approved = true AND applied = true]";
  const direct = `array::len(${arrow}${filter})`;
  const viaBlocks = `array::len(<-contained_in<-block${arrow}${filter})`;
  return `(${direct} + ${viaBlocks})`;
}

const OUTBOUND = edgeCountExpr("out");
const INBOUND = edgeCountExpr("in");

/**
 * One aggregate query returns exactly the notes eligible for promotion, with
 * their edge counts joined in SQL and the ladder's thresholds pushed down as
 * predicates. `LIMIT` enforces {@link MAX_PROMOTIONS_PER_TICK} server-side,
 * so the agent no longer selects the whole vault and then issues two count
 * queries per note.
 */
const CANDIDATE_SQL = `SELECT
  path,
  word_count,
  maturity,
  ${OUTBOUND} AS outbound,
  ${INBOUND} AS inbound
FROM note
WHERE tombstoned_at IS NONE
  AND (
    ((maturity IS NONE OR maturity = 'raw') AND word_count > 0)
    OR (
      maturity = 'adolescent'
      AND word_count >= 200
      AND last_user_edit_at IS NOT NONE
      AND last_user_edit_at < $staleBefore
      AND (${OUTBOUND} + ${INBOUND}) >= 5
    )
    OR (maturity = 'mature' AND ${OUTBOUND} >= 10 AND ${INBOUND} >= 3)
  )
ORDER BY word_count DESC
LIMIT ${MAX_PROMOTIONS_PER_TICK};`;

interface CandidateRow {
  path: string;
  word_count: number;
  maturity: Maturity | null;
  outbound: number;
  inbound: number;
}

export class MaturityAdvancer implements Agent {
  readonly name = "maturityAdvancer" as const;
  readonly usesReasoningModel = false;

  constructor(private readonly options: MaturityAdvancerOptions) {
    if (typeof options.settings !== "function") {
      throw new Error("MaturityAdvancer settings must be a function");
    }
    assertMaturitySettings(options.settings());
  }

  async run(context: AgentRunContext): Promise<AgentRunResult> {
    const rows = await this.fetchCandidates();
    let promotions = 0;
    for (const row of rows) {
      if (promotions >= MAX_PROMOTIONS_PER_TICK) break;
      const current = row.maturity ?? "raw";
      const next = nextMaturity(current, row);
      if (next === current) continue;
      if (!(await this.applyPromotion(row.path, current, next))) continue;
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

  private async fetchCandidates(): Promise<CandidateRow[]> {
    const staleBefore = new DateTime(new Date(Date.now() - SEVEN_DAYS_MS));
    const result: unknown = await this.options.db.query(CANDIDATE_SQL, { staleBefore }).collect();
    const rows = readSingleStatementRows(result, "maturity candidates").map(parseCandidateRow);
    if (rows.length > MAX_PROMOTIONS_PER_TICK) {
      throw new Error("maturity storage integrity: candidate query exceeded its server-side limit");
    }
    const paths = new Set<string>();
    for (const row of rows) {
      if (paths.has(row.path)) {
        throw new Error(`maturity storage integrity: duplicate candidate path ${row.path}`);
      }
      paths.add(row.path);
    }
    return rows;
  }

  /**
   * Persist the promotion. With frontmatter writeback enabled, the guarded
   * filesystem transition happens first. A persistent editor race therefore
   * cannot strand the database on a rung that the next candidate query will
   * never revisit. A returned DB precondition miss is inspected and the exact
   * automated bytes are rolled back unless another worker already committed
   * the same rung. An ambiguous DB exception leaves the forward bytes in
   * place: either the commit landed and both stores agree, or the unchanged DB
   * candidate is retried on the next tick.
   */
  private async applyPromotion(path: string, current: Maturity, next: Maturity): Promise<boolean> {
    const settings = this.options.settings();
    assertMaturitySettings(settings);
    if (!settings.writeToFrontmatter) return await this.promoteDatabase(path, current, next);

    const patch = { maturity: next, updatedAt: new Date().toISOString() } as const;
    for (let attempt = 0; attempt < 5; attempt++) {
      const before = await this.options.facade.read(path);
      const updated = upsertMaturityFrontmatter(before, patch);
      if (updated === before) return await this.promoteDatabase(path, current, next);
      if (!(await this.options.facade.writeIfUnchanged(path, before, updated))) continue;

      const promoted = await this.promoteDatabase(path, current, next);
      if (promoted) return true;
      if ((await this.readStoredMaturity(path)) === next) return false;
      await this.options.facade.writeIfUnchanged(path, updated, before);
      return false;
    }
    throw new Error(`maturity frontmatter conflict: ${path} changed during every guarded retry`);
  }

  private async promoteDatabase(path: string, current: Maturity, next: Maturity): Promise<boolean> {
    const result: unknown = await this.options.db
      .query(
        `UPDATE note SET maturity = $next
         WHERE path = $path AND tombstoned_at IS NONE
           AND (maturity = $current OR ($current = 'raw' AND maturity IS NONE))
         RETURN AFTER;`,
        { next, current, path },
      )
      .collect();
    const rows = readSingleStatementRows(result, "maturity promotion");
    if (rows.length === 0) return false;
    if (rows.length !== 1 || !isRecord(rows[0])) {
      throw new Error("maturity storage integrity: promotion did not update exactly one note");
    }
    if (rows[0].path !== path || rows[0].maturity !== next) {
      throw new Error("maturity storage integrity: promotion returned the wrong note state");
    }
    return true;
  }

  private async readStoredMaturity(path: string): Promise<Maturity | null> {
    const result: unknown = await this.options.db
      .query("SELECT maturity FROM note WHERE path = $path AND tombstoned_at IS NONE LIMIT 1;", {
        path,
      })
      .collect();
    const rows = readSingleStatementRows(result, "maturity reconciliation");
    if (rows.length === 0) return null;
    if (rows.length !== 1 || !isRecord(rows[0])) {
      throw new Error("maturity storage integrity: reconciliation did not return one note");
    }
    return parseStoredMaturity(rows[0].maturity);
  }
}

function assertMaturitySettings(value: unknown): asserts value is MaturityAdvancerSettings {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { writeToFrontmatter?: unknown }).writeToFrontmatter !== "boolean"
  ) {
    throw new Error("MaturityAdvancer settings.writeToFrontmatter must be a boolean");
  }
}

/**
 * Pure ladder step, exported for unit tests. The SQL candidate query already
 * enforced the thresholds; this maps a qualifying row to its next rung.
 */
export function nextMaturity(
  current: Maturity,
  counts: { word_count: number; inbound: number; outbound: number },
): Maturity {
  assertMaturity(current, "maturity ladder current value");
  assertNonNegativeSafeInteger(counts.word_count, "maturity ladder word_count");
  assertNonNegativeSafeInteger(counts.inbound, "maturity ladder inbound");
  assertNonNegativeSafeInteger(counts.outbound, "maturity ladder outbound");
  if (current === "raw" && counts.word_count > 0) return "adolescent";
  if (
    current === "adolescent" &&
    counts.word_count >= 200 &&
    counts.inbound + counts.outbound >= 5
  ) {
    return "mature";
  }
  if (current === "mature" && counts.outbound >= 10 && counts.inbound >= 3) {
    return "synthesis-ready";
  }
  return current;
}

const FRONTMATTER_FENCE = "---";

interface MaturityPatch {
  maturity: Maturity;
  updatedAt: string;
}

/**
 * Private frontmatter mutation for the maturity advancer's `notient.vitals`
 * and `notient.updated` slots. The helper stays narrow because no other
 * frontmatter fields belong to this agent.
 */
function upsertMaturityFrontmatter(content: string, patch: MaturityPatch): string {
  const parts = readFrontmatter(content);
  const root = parts === null ? {} : parseYamlObject(parts.yaml);
  const notient = ensureMapping(root, "notient");
  const vitals = ensureMapping(notient, "vitals");
  vitals.maturity = patch.maturity;
  notient.vitals = vitals;
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
  if (closeIdx === -1) {
    throw new Error("frontmatter opening fence has no closing fence");
  }
  const yaml = content.slice(headerLen, closeIdx + 1);
  const after = closeIdx + 1 + FRONTMATTER_FENCE.length;
  const body = content.slice(after).replace(/^\r?\n/, "");
  return { yaml, body };
}

function parseYamlObject(value: string): Record<string, unknown> {
  if (value.trim().length === 0) return {};
  const parsed = YAML.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("frontmatter root must be a mapping");
  }
  return { ...(parsed as Record<string, unknown>) };
}

function ensureMapping(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = parent[key];
  if (existing === undefined) return {};
  if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
    throw new Error(`frontmatter.${key} must be a mapping`);
  }
  return { ...(existing as Record<string, unknown>) };
}

function parseCandidateRow(raw: unknown): CandidateRow {
  if (!isRecord(raw)) {
    throw new Error("maturity storage integrity: candidate row is not an object");
  }
  if (typeof raw.path !== "string" || raw.path.trim().length === 0) {
    throw new Error("maturity storage integrity: candidate path is invalid");
  }
  assertNonNegativeSafeInteger(raw.word_count, "maturity stored word_count");
  assertNonNegativeSafeInteger(raw.outbound, "maturity stored outbound");
  assertNonNegativeSafeInteger(raw.inbound, "maturity stored inbound");
  return {
    path: raw.path,
    word_count: raw.word_count,
    maturity: parseStoredMaturity(raw.maturity),
    outbound: raw.outbound,
    inbound: raw.inbound,
  };
}

function parseStoredMaturity(raw: unknown): Maturity | null {
  if (raw === undefined) return null;
  if (raw === null) {
    throw new Error("maturity storage integrity: maturity uses null instead of NONE");
  }
  assertMaturity(raw, "maturity stored maturity");
  return raw;
}

function assertMaturity(raw: unknown, label: string): asserts raw is Maturity {
  if (raw !== "raw" && raw !== "adolescent" && raw !== "mature" && raw !== "synthesis-ready") {
    throw new Error(`${label} is invalid`);
  }
}

function assertNonNegativeSafeInteger(raw: unknown, label: string): asserts raw is number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

function readSingleStatementRows(raw: unknown, label: string): unknown[] {
  if (!Array.isArray(raw) || raw.length !== 1 || !Array.isArray(raw[0])) {
    throw new Error(`${label} storage integrity: invalid statement envelope`);
  }
  return raw[0];
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}
