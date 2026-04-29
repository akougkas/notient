/**
 * agent.brief RPC handler (Phase D1 LD-9).
 *
 * Where agent.ask drives a tool-using LLM loop, agent.brief composes a
 * structured snapshot of what the vault knows about a topic or about a
 * specific file. The handler runs deterministic queries (vector search
 * plus three graph queries) and then makes ONE LLM call to compose the
 * 2-3 sentence summary paragraph. There is no tool loop, no agentic
 * reasoning, and no ChatService involvement.
 *
 * Graph filtering notes:
 *
 *   - Decisions: claims today carry payload `{text}` only; the spec calls
 *     for filtering on `payload.maturity = 'decision'`. The handler parses
 *     the JSON payload column in JS and matches on the field. Until upstream
 *     producers stamp the field, the list is empty by design.
 *   - Open questions: question payload has no `answered` field today, so
 *     absence means unanswered. The handler treats a literal `true` as
 *     answered and filters everything else through.
 *   - Contradictions: the agent_events ledger (T2) stores
 *     `swarm:contradiction_discovered` rows. We filter by overlap between
 *     the event's `notePaths` payload and the relevantNotes path set.
 */

import type { VaultFacade } from "../../core/chat/tools/vault";
import type { Database } from "../../core/db/database";
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
  database: Database;
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
  updated_at: number;
}

interface ClaimRow {
  id: string;
  label: string;
  payload: string | null;
  note_path: string | null;
  created_at: number;
}

interface QuestionRow {
  id: string;
  label: string;
  payload: string | null;
  note_path: string | null;
}

interface AgentEventRow {
  payload: string;
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
    database: deps.database,
    queryString,
    maxNotes: parsed.maxNotes,
    signal: controller.signal,
  });
  const relevantPaths = new Set(relevantNotes.map((note) => note.path));
  const recentDecisions = collectRecentDecisions(deps.database, relevantPaths, parsed.maxDecisions);
  const openQuestions = collectOpenQuestions(deps.database, relevantPaths, parsed.maxQuestions);
  const openContradictions = collectOpenContradictions(
    deps.database,
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
  database: Database;
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
  return limited.map((hit) => ({
    path: hit.notePath,
    score: hit.score,
    snippet: hit.snippet,
    lastTouchedAt: readNoteUpdatedAt(options.database, hit.notePath),
  }));
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

function readNoteUpdatedAt(database: Database, notePath: string): number {
  const rows = database.query<NoteUpdatedAtRow>(
    "SELECT updated_at FROM notes WHERE path = ? LIMIT 1;",
    [notePath],
  );
  return rows[0]?.updated_at ?? 0;
}

function collectRecentDecisions(
  database: Database,
  relevantPaths: Set<string>,
  maxDecisions: number,
): AgentBriefDecision[] {
  if (relevantPaths.size === 0) return [];
  const placeholders = Array.from(relevantPaths, () => "?").join(",");
  const rows = database.query<ClaimRow>(
    `SELECT id, label, payload, note_path, created_at FROM graph_nodes
     WHERE type = 'claim' AND note_path IN (${placeholders})
     ORDER BY created_at DESC;`,
    Array.from(relevantPaths),
  );
  const out: AgentBriefDecision[] = [];
  for (const row of rows) {
    const parsed = parsePayload(row.payload);
    if (!isDecisionPayload(parsed)) continue;
    if (row.note_path === null) continue;
    out.push({ id: row.id, text: row.label, notePath: row.note_path, ts: row.created_at });
    if (out.length >= maxDecisions) break;
  }
  return out;
}

function collectOpenQuestions(
  database: Database,
  relevantPaths: Set<string>,
  maxQuestions: number,
): AgentBriefQuestion[] {
  if (relevantPaths.size === 0) return [];
  const placeholders = Array.from(relevantPaths, () => "?").join(",");
  // Spec calls for question nodes linked via graph_edges.target_id to a node
  // whose note_path is in the relevant set. The indexer wires `asks` edges
  // from the note node (source) to the question node (target), so a question
  // node with note_path inside the relevant set is the same set the JOIN
  // would produce. We also union direct note_path matches for indexer paths
  // that pre-populate question.note_path.
  const rows = database.query<QuestionRow>(
    `SELECT DISTINCT q.id AS id, q.label AS label, q.payload AS payload, q.note_path AS note_path
     FROM graph_nodes q
     LEFT JOIN graph_edges e ON e.target_id = q.id
     LEFT JOIN graph_nodes source_node ON source_node.id = e.source_id
     WHERE q.type = 'question'
       AND (
         q.note_path IN (${placeholders})
         OR source_node.note_path IN (${placeholders})
       );`,
    [...relevantPaths, ...relevantPaths],
  );
  const out: AgentBriefQuestion[] = [];
  for (const row of rows) {
    const parsed = parsePayload(row.payload);
    if (isAnswered(parsed)) continue;
    const notePath = row.note_path ?? "";
    if (notePath === "") continue;
    out.push({ id: row.id, text: row.label, notePath });
    if (out.length >= maxQuestions) break;
  }
  return out;
}

function collectOpenContradictions(
  database: Database,
  relevantPaths: Set<string>,
  maxContradictions: number,
): AgentBriefContradiction[] {
  if (relevantPaths.size === 0) return [];
  const rows = database.query<AgentEventRow>(
    "SELECT payload FROM agent_events WHERE type = 'swarm:contradiction_discovered' ORDER BY id DESC;",
  );
  const out: AgentBriefContradiction[] = [];
  for (const row of rows) {
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

function parsePayload(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
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

function isDecisionPayload(payload: Record<string, unknown> | null): boolean {
  if (payload === null) return false;
  return payload.maturity === "decision";
}

function isAnswered(payload: Record<string, unknown> | null): boolean {
  if (payload === null) return false;
  return payload.answered === true;
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
