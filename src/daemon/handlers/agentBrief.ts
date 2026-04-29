/**
 * agent.brief RPC handler (Phase D1 LD-9, Phase 5 Task 4 SurrealDB cutover).
 *
 * Where agent.ask drives a tool-using LLM loop, agent.brief composes a
 * structured snapshot of what the vault knows about a topic or about a
 * specific file. The handler runs deterministic queries (vector search
 * plus three graph queries) and then makes ONE LLM call to compose the
 * 2-3 sentence summary paragraph. There is no tool loop, no agentic
 * reasoning, and no ChatService involvement.
 *
 * Storage: every read in this handler now lives in SurrealDB. Phase 5
 * Task 4 retired the SQLite `notes` and `graph_nodes` carry-forwards:
 *
 *   - `lastTouchedAt` reads `note.last_user_edit_at` (the SurrealDB
 *     analogue of the legacy `notes.updated_at` column) and reports
 *     epoch seconds. Notes with NONE in `last_user_edit_at` round-trip
 *     as 0, matching the SQLite path's `?? 0` semantics.
 *   - Claims and questions stream from the `asserts` and `asks` edge
 *     tables. Each row is a relation `note|block -> claim|question`,
 *     so the WHERE clause covers both block-rooted and note-rooted
 *     extractions via `in.path INSIDE $paths OR in.note.path INSIDE
 *     $paths`. Edges are filtered through `approved = true AND applied
 *     = true` to match the search-consumer contract documented in
 *     `edgeTables.ts::provenanceFields`.
 *   - The `agent_event` ledger backs the `swarm:contradiction_discovered`
 *     lookup. The ledger has lived in SurrealDB since Phase 4 Task 12.
 *
 * Wire-shape preservation notes:
 *
 *   - Decisions: the Phase 1 `claim` table has no `maturity` column, so
 *     the SQLite-era `payload.maturity = 'decision'` filter is dropped.
 *     Every approved claim attached to a relevant note is treated as a
 *     decision; the wire shape is identical (`{id, text, notePath, ts}`),
 *     only the population semantic widens. Once a producer stamps a
 *     maturity field on `claim`, this filter can be reintroduced without
 *     touching consumers.
 *   - Open questions: every approved question attached to a relevant
 *     note is treated as open. The legacy `payload.answered === true`
 *     filter has no SurrealDB analogue today; if a follow-up adds an
 *     `answered` field on `question`, restore the filter here.
 *   - Decision/question `id`s use the entity's content-addressed `sha`
 *     so callers see a stable string id without leaking the SurrealDB
 *     RecordId format.
 */

import { DateTime, type Surreal } from "surrealdb";
import type { VaultFacade } from "../../core/chat/tools/vault";
import type { LLMProvider, ChatMessage as ProviderChatMessage } from "../../core/llm/provider";
import type { SearchEvent, SearchHit, SearchQuery, SearchResult } from "../../core/search/types";

/**
 * Minimal slice of SearchPipeline that agent.brief depends on. Declared
 * structurally so the daemon wires the real {@link SearchPipeline} and tests
 * can pass a scripted fake without subclassing.
 */
export interface BriefSearchPipeline {
  run(query: SearchQuery, signal: AbortSignal): AsyncIterable<SearchEvent>;
}

export interface AgentBriefHandlerDeps {
  /**
   * SurrealDB connection. All four reads (note `last_user_edit_at`, the
   * `asserts` and `asks` edge traversals, and the `agent_event` ledger
   * lookup) hit this connection. Phase 5 Task 4 dropped the SQLite
   * `Database` dependency that previously co-existed for `notes.updated_at`
   * and `graph_nodes`.
   */
  surrealDb: Surreal;
  searchPipeline: BriefSearchPipeline;
  vault: VaultFacade;
  provider: LLMProvider;
  settings: () => AgentBriefRuntimeSettings;
}

export interface AgentBriefRuntimeSettings {
  model: string;
}

export interface AgentBriefRelevantNote {
  path: string;
  score: number;
  snippet: string;
  lastTouchedAt: number;
}

export interface AgentBriefDecision {
  id: string;
  text: string;
  notePath: string;
  ts: number;
}

export interface AgentBriefQuestion {
  id: string;
  text: string;
  notePath: string;
}

export interface AgentBriefContradiction {
  pair: [string, string];
  severity: number;
}

export interface AgentBriefResponsePayload {
  topic: string;
  summary: string;
  relevantNotes: AgentBriefRelevantNote[];
  recentDecisions: AgentBriefDecision[];
  openQuestions: AgentBriefQuestion[];
  openContradictions: AgentBriefContradiction[];
  durationMs: number;
}

export const AGENT_BRIEF_DEFAULT_MAX_NOTES = 8;
export const AGENT_BRIEF_DEFAULT_MAX_QUESTIONS = 5;
export const AGENT_BRIEF_DEFAULT_MAX_DECISIONS = 5;
export const AGENT_BRIEF_FILE_CONTENT_CAP_CHARS = 4000;
export const AGENT_BRIEF_SUMMARY_MAX_TOKENS = 400;

const BRIEF_SYSTEM_PROMPT =
  "You compose a short knowledge brief. Given a topic, a list of relevant notes with snippets, recent decisions, and open questions, write 2 to 3 sentences in plain prose that summarizes what the vault knows about the topic. Stay grounded in the supplied evidence; do not invent. If evidence is thin, say so plainly.";

export type AgentBriefHandler = (
  params: Record<string, unknown>,
  emit: (line: string) => void,
  envelopeId: string,
  clientIdentity: string,
) => Promise<Record<string, unknown>>;

interface ParsedBriefParams {
  topic: string | null;
  filePath: string | null;
  maxNotes: number;
  maxQuestions: number;
  maxDecisions: number;
}

interface NoteUpdatedAtRow {
  /**
   * SurrealDB datetimes round-trip as `DateTime` SDK instances; the
   * `option<datetime>` field surfaces as `null` (or `undefined`) when NONE.
   */
  last_user_edit_at: DateTime | null | undefined;
}

interface ClaimEdgeRow {
  text: string;
  sha: string;
  notePath: string | null;
  blockNotePath: string | null;
  created_at: DateTime;
}

interface QuestionEdgeRow {
  text: string;
  sha: string;
  notePath: string | null;
  blockNotePath: string | null;
  created_at: DateTime;
}

interface AgentEventRow {
  payload: string | null | undefined;
}

interface ContradictionEventPayload {
  pair?: [string, string];
  severity?: number;
  notePaths?: string[];
}

export function makeAgentBriefHandler(deps: AgentBriefHandlerDeps): AgentBriefHandler {
  return (params) => runBrief(deps, parseBriefParams(params));
}

async function runBrief(
  deps: AgentBriefHandlerDeps,
  parsed: ParsedBriefParams,
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  const controller = new AbortController();

  const { queryString, echoedTopic } = await resolveQuery(parsed, deps.vault);
  const relevantNotes = await runVectorSearch({
    pipeline: deps.searchPipeline,
    surrealDb: deps.surrealDb,
    queryString,
    maxNotes: parsed.maxNotes,
    signal: controller.signal,
  });
  const relevantPaths = new Set(relevantNotes.map((note) => note.path));
  const recentDecisions = await collectRecentDecisions(
    deps.surrealDb,
    relevantPaths,
    parsed.maxDecisions,
  );
  const openQuestions = await collectOpenQuestions(
    deps.surrealDb,
    relevantPaths,
    parsed.maxQuestions,
  );
  const openContradictions = await collectOpenContradictions(
    deps.surrealDb,
    relevantPaths,
    parsed.maxQuestions,
  );
  const summary = await composeSummary({
    provider: deps.provider,
    model: deps.settings().model,
    topic: echoedTopic,
    relevantNotes,
    recentDecisions,
    openQuestions,
    signal: controller.signal,
  });

  const response: AgentBriefResponsePayload = {
    topic: echoedTopic,
    summary,
    relevantNotes,
    recentDecisions,
    openQuestions,
    openContradictions,
    durationMs: Date.now() - startedAt,
  };
  return { ok: true, ...response };
}

function parseBriefParams(params: Record<string, unknown>): ParsedBriefParams {
  const rawTopic = typeof params.topic === "string" ? params.topic.trim() : "";
  const rawFilePath = typeof params.filePath === "string" ? params.filePath.trim() : "";
  const hasTopic = rawTopic.length > 0;
  const hasFilePath = rawFilePath.length > 0;
  if (hasTopic && hasFilePath) {
    throw new Error("INVALID_PARAMS: pass exactly one of topic or filePath, not both");
  }
  if (!hasTopic && !hasFilePath) {
    throw new Error("INVALID_PARAMS: topic or filePath is required");
  }
  if (hasFilePath && containsParentTraversal(rawFilePath)) {
    throw new Error("INVALID_PARAMS: filePath must not contain '..' traversal segments");
  }
  return {
    topic: hasTopic ? rawTopic : null,
    filePath: hasFilePath ? rawFilePath : null,
    maxNotes: parsePositiveInt(params.maxNotes, AGENT_BRIEF_DEFAULT_MAX_NOTES, "maxNotes"),
    maxQuestions: parsePositiveInt(
      params.maxQuestions,
      AGENT_BRIEF_DEFAULT_MAX_QUESTIONS,
      "maxQuestions",
    ),
    maxDecisions: parsePositiveInt(
      params.maxDecisions,
      AGENT_BRIEF_DEFAULT_MAX_DECISIONS,
      "maxDecisions",
    ),
  };
}

function parsePositiveInt(raw: unknown, fallback: number, label: string): number {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    throw new Error(`INVALID_PARAMS: ${label} must be a positive number`);
  }
  return Math.floor(raw);
}

function containsParentTraversal(filePath: string): boolean {
  const segments = filePath.split(/[\\/]/);
  return segments.some((segment) => segment === "..");
}

async function resolveQuery(
  parsed: ParsedBriefParams,
  vault: VaultFacade,
): Promise<{ queryString: string; echoedTopic: string }> {
  if (parsed.topic !== null) {
    return { queryString: parsed.topic, echoedTopic: parsed.topic };
  }
  if (parsed.filePath === null) {
    // Unreachable; parseBriefParams guarantees one of topic/filePath is set.
    throw new Error("INVALID_PARAMS: filePath unexpectedly null");
  }
  const body = await vault.readNote(parsed.filePath);
  const truncated =
    body.length > AGENT_BRIEF_FILE_CONTENT_CAP_CHARS
      ? body.slice(0, AGENT_BRIEF_FILE_CONTENT_CAP_CHARS)
      : body;
  return { queryString: truncated, echoedTopic: filePathToTopicLabel(parsed.filePath) };
}

function filePathToTopicLabel(filePath: string): string {
  const lastSeparator = filePath.lastIndexOf("/");
  const basename = lastSeparator === -1 ? filePath : filePath.slice(lastSeparator + 1);
  const dotIndex = basename.lastIndexOf(".");
  return dotIndex <= 0 ? basename : basename.slice(0, dotIndex);
}

interface VectorSearchOptions {
  pipeline: BriefSearchPipeline;
  surrealDb: Surreal;
  queryString: string;
  maxNotes: number;
  signal: AbortSignal;
}

async function runVectorSearch(options: VectorSearchOptions): Promise<AgentBriefRelevantNote[]> {
  let result: SearchResult | null = null;
  for await (const event of options.pipeline.run(
    { query: options.queryString, mode: "balanced", limit: options.maxNotes },
    options.signal,
  )) {
    if (event.type === "search:done") {
      result = event.result;
    }
  }
  if (result === null) return [];
  const dedupedByPath = dedupeHitsByPath(result.hits);
  const limited = dedupedByPath.slice(0, options.maxNotes);
  const relevant: AgentBriefRelevantNote[] = [];
  for (const hit of limited) {
    relevant.push({
      path: hit.notePath,
      score: hit.score,
      snippet: hit.snippet,
      lastTouchedAt: await readNoteUpdatedAt(options.surrealDb, hit.notePath),
    });
  }
  return relevant;
}

function dedupeHitsByPath(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const hit of hits) {
    if (seen.has(hit.notePath)) continue;
    seen.add(hit.notePath);
    out.push(hit);
  }
  return out;
}

async function readNoteUpdatedAt(db: Surreal, notePath: string): Promise<number> {
  const [rows] = await db
    .query<[NoteUpdatedAtRow[]]>(
      "SELECT last_user_edit_at FROM note WHERE path = $path LIMIT 1;",
      { path: notePath },
    )
    .collect<[NoteUpdatedAtRow[]]>();
  const value = rows[0]?.last_user_edit_at;
  if (value === null || value === undefined) return 0;
  return Math.floor(value.toDate().getTime() / 1000);
}

async function collectRecentDecisions(
  db: Surreal,
  relevantPaths: Set<string>,
  maxDecisions: number,
): Promise<AgentBriefDecision[]> {
  if (relevantPaths.size === 0) return [];
  // SurrealDB 3.x requires every ORDER BY field to appear in the projection;
  // `created_at` is selected and discarded by the caller. The WHERE clause
  // accepts both note-rooted (`in` is a `note`) and block-rooted (`in` is a
  // `block` whose `note` field points back to the note) extractions.
  const sql = `SELECT
      out.text AS text,
      out.sha AS sha,
      in.path AS notePath,
      in.note.path AS blockNotePath,
      created_at
    FROM asserts
    WHERE (in.path INSIDE $paths OR in.note.path INSIDE $paths)
      AND approved = true
      AND applied = true
    ORDER BY created_at DESC;`;
  const [rows] = await db
    .query<[ClaimEdgeRow[]]>(sql, { paths: Array.from(relevantPaths) })
    .collect<[ClaimEdgeRow[]]>();
  const out: AgentBriefDecision[] = [];
  for (const row of rows) {
    const notePath = row.notePath ?? row.blockNotePath;
    if (notePath === null) continue;
    out.push({
      id: row.sha,
      text: row.text,
      notePath,
      ts: Math.floor(row.created_at.toDate().getTime() / 1000),
    });
    if (out.length >= maxDecisions) break;
  }
  return out;
}

async function collectOpenQuestions(
  db: Surreal,
  relevantPaths: Set<string>,
  maxQuestions: number,
): Promise<AgentBriefQuestion[]> {
  if (relevantPaths.size === 0) return [];
  // Same `in.path` / `in.note.path` union as collectRecentDecisions to cover
  // both note-rooted and block-rooted question extractions. Ordering by
  // `created_at` keeps the wire ordering stable across reruns even though the
  // wire shape does not surface a timestamp.
  const sql = `SELECT
      out.text AS text,
      out.sha AS sha,
      in.path AS notePath,
      in.note.path AS blockNotePath,
      created_at
    FROM asks
    WHERE (in.path INSIDE $paths OR in.note.path INSIDE $paths)
      AND approved = true
      AND applied = true
    ORDER BY created_at DESC;`;
  const [rows] = await db
    .query<[QuestionEdgeRow[]]>(sql, { paths: Array.from(relevantPaths) })
    .collect<[QuestionEdgeRow[]]>();
  const out: AgentBriefQuestion[] = [];
  for (const row of rows) {
    const notePath = row.notePath ?? row.blockNotePath;
    if (notePath === null) continue;
    out.push({ id: row.sha, text: row.text, notePath });
    if (out.length >= maxQuestions) break;
  }
  return out;
}

async function collectOpenContradictions(
  db: Surreal,
  relevantPaths: Set<string>,
  maxContradictions: number,
): Promise<AgentBriefContradiction[]> {
  if (relevantPaths.size === 0) return [];
  // SurrealDB 3.x requires every ORDER BY field to appear in the projection;
  // `seq` is the cursor field assigned at insert time by AgentEventStore.
  const [rows] = await db
    .query<[AgentEventRow[]]>(
      "SELECT payload, seq FROM agent_event WHERE kind = 'swarm:contradiction_discovered' ORDER BY seq DESC;",
    )
    .collect<[AgentEventRow[]]>();
  const out: AgentBriefContradiction[] = [];
  for (const row of rows) {
    if (row.payload === null || row.payload === undefined) continue;
    const candidate = toContradictionRecord(row.payload, relevantPaths);
    if (candidate === null) continue;
    out.push(candidate);
    if (out.length >= maxContradictions) break;
  }
  return out;
}

function toContradictionRecord(
  rawPayload: string,
  relevantPaths: Set<string>,
): AgentBriefContradiction | null {
  const payload = parseContradictionPayload(rawPayload);
  if (payload === null) return null;
  if (!hasOverlap(payload.notePaths ?? [], relevantPaths)) return null;
  const { pair, severity } = payload;
  if (!Array.isArray(pair) || pair.length !== 2) return null;
  if (typeof pair[0] !== "string" || typeof pair[1] !== "string") return null;
  if (typeof severity !== "number" || !Number.isFinite(severity)) return null;
  return { pair: [pair[0], pair[1]], severity };
}

function parseContradictionPayload(raw: string): ContradictionEventPayload | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as ContradictionEventPayload;
  } catch {
    return null;
  }
}

function hasOverlap(eventPaths: string[], relevantPaths: Set<string>): boolean {
  for (const candidate of eventPaths) {
    if (relevantPaths.has(candidate)) return true;
  }
  return false;
}

interface SummaryOptions {
  provider: LLMProvider;
  model: string;
  topic: string;
  relevantNotes: AgentBriefRelevantNote[];
  recentDecisions: AgentBriefDecision[];
  openQuestions: AgentBriefQuestion[];
  signal: AbortSignal;
}

async function composeSummary(options: SummaryOptions): Promise<string> {
  const userMessage = buildUserMessage(options);
  const messages: ProviderChatMessage[] = [
    { role: "system", content: BRIEF_SYSTEM_PROMPT },
    { role: "user", content: userMessage },
  ];
  try {
    const result = await options.provider.chat(messages, {
      model: options.model,
      temperature: 0.2,
      maxTokens: AGENT_BRIEF_SUMMARY_MAX_TOKENS,
      signal: options.signal,
      enableThinking: false,
    });
    return result.trim();
  } catch {
    // The structured fields are still useful on their own; swallow the
    // error and let the caller see an empty summary.
    return "";
  }
}

function buildUserMessage(options: SummaryOptions): string {
  const lines: string[] = [];
  lines.push(`Topic: ${options.topic}`);
  lines.push("");
  lines.push("Relevant notes:");
  if (options.relevantNotes.length === 0) {
    lines.push("- (none)");
  } else {
    for (const note of options.relevantNotes) {
      lines.push(`- ${note.path}: ${note.snippet}`);
    }
  }
  lines.push("");
  lines.push("Recent decisions:");
  if (options.recentDecisions.length === 0) {
    lines.push("- (none)");
  } else {
    for (const decision of options.recentDecisions) {
      lines.push(`- ${decision.notePath}: ${decision.text}`);
    }
  }
  lines.push("");
  lines.push("Open questions:");
  if (options.openQuestions.length === 0) {
    lines.push("- (none)");
  } else {
    for (const question of options.openQuestions) {
      lines.push(`- ${question.notePath}: ${question.text}`);
    }
  }
  return lines.join("\n");
}

