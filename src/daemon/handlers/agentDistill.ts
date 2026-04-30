/**
 * agent.distill RPC handler (Phase D1 T5).
 *
 * Ingests an external transcript (markdown / JSONL / JSON) supplied by an
 * external skill, runs the TranscriptDistiller against it, and lands
 * candidate proposals as markdown files under
 * `<vault>/Notient/proposals/distilled-*.md`.
 *
 * Why a new agent instead of reusing Synthesizer:
 *
 *   - Synthesizer.run reads `notes` / `embeddings` / `chunks` from the DB and
 *     clusters them via DBSCAN. It cannot ingest external transcript chunks
 *     and it returns `{ proposals: number }`, not a typed candidate list.
 *   - Synthesizer only emits `type = "synthesis"` rows, but the spec calls
 *     for four kinds (claim / decision / question / note).
 *   - Extractor (`core/indexer/extractor.ts`) covers two of the four kinds
 *     and is wired against the indexer pipeline.
 *
 * The TranscriptDistiller in `core/distill/transcriptDistiller.ts` runs a
 * single LLM call against a parsed transcript and returns the four-kind
 * candidate list directly. The handler stays thin: it parses, calls the
 * distiller, and writes proposal files.
 *
 * Path resolution accepts both vault-relative and absolute paths so a caller
 * can point at `~/.claude/projects/<slug>/*.jsonl` files that live outside
 * the vault. Both forms reject `..` traversal.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { Candidate, TranscriptDistiller } from "../../core/distill/transcriptDistiller";
import {
  type TranscriptFormat,
  type TranscriptMessage,
  detectFormat,
  parseTranscript,
} from "../../core/distill/transcriptParser";
import { encodeEvent } from "../rpc";

export interface AgentDistillHandlerDeps {
  vaultRoot: string;
  distiller: TranscriptDistiller;
}

export type AgentDistillHandler = (
  params: Record<string, unknown>,
  emit: (line: string) => void,
  envelopeId: string,
  clientIdentity: string,
) => Promise<Record<string, unknown>>;

const PROPOSALS_FOLDER = "Notient/proposals";
const TITLE_MAX_CHARS = 80;
const SUPPORTED_FORMATS: ReadonlySet<TranscriptFormat> = new Set([
  "auto",
  "markdown",
  "jsonl",
  "json",
]);

interface ParsedDistillParams {
  transcriptPath: string;
  format: TranscriptFormat;
  dryRun: boolean;
}

export function makeAgentDistillHandler(deps: AgentDistillHandlerDeps): AgentDistillHandler {
  return async (params, emit, envelopeId, clientIdentity) => {
    const startedAt = Date.now();
    const parsed = parseDistillParams(params);
    const absolutePath = resolveTranscriptPath(parsed.transcriptPath, deps.vaultRoot);
    const content = await readTranscriptFile(absolutePath, parsed.transcriptPath);
    const format = parsed.format === "auto" ? detectFormat(content, absolutePath) : parsed.format;
    const messages = parseTranscript(content, format);
    // Path B fallback. `parseTranscript` returns an empty array when the
    // input lacks transcript markers (e.g., a plain vault note). The
    // distiller would then short-circuit to `[]` and the CLI would return
    // an empty result with no signal. Treat the file body as a single
    // synthetic user message so the LLM still runs, and emit a
    // `distill:fallback` event so the caller knows the path was taken.
    let inputMessages = messages;
    if (inputMessages.length === 0) {
      emit(
        encodeEvent(envelopeId, "distill:fallback", {
          reason: "non-transcript",
          transcriptPath: parsed.transcriptPath,
        }),
      );
      inputMessages = [
        {
          sourceMessageId: `vault-note:${basename(absolutePath)}`,
          role: "user",
          content,
        },
      ];
    }
    const candidates = await deps.distiller.distill(inputMessages);
    const proposalsCreated = parsed.dryRun
      ? 0
      : await writeProposalFiles({
          vaultRoot: deps.vaultRoot,
          candidates,
          transcriptPath: parsed.transcriptPath,
          clientIdentity,
        });
    const byKind = tallyByKind(candidates);
    return {
      ok: true,
      candidates,
      proposalsCreated,
      byKind,
      durationMs: Date.now() - startedAt,
    };
  };
}

function parseDistillParams(params: Record<string, unknown>): ParsedDistillParams {
  const rawPath = params.transcriptPath;
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    throw new Error("INVALID_PARAMS: transcriptPath is required");
  }
  if (containsParentTraversal(rawPath)) {
    throw new Error("INVALID_PARAMS: transcriptPath must not contain '..' traversal segments");
  }
  const rawFormat = params.format ?? "auto";
  if (typeof rawFormat !== "string" || !SUPPORTED_FORMATS.has(rawFormat as TranscriptFormat)) {
    throw new Error("INVALID_PARAMS: format must be one of auto | markdown | jsonl | json");
  }
  const dryRun = params.dryRun === true;
  return {
    transcriptPath: rawPath,
    format: rawFormat as TranscriptFormat,
    dryRun,
  };
}

function containsParentTraversal(path: string): boolean {
  const segments = path.split(/[\\/]/);
  return segments.some((segment) => segment === "..");
}

function resolveTranscriptPath(transcriptPath: string, vaultRoot: string): string {
  if (isAbsolute(transcriptPath)) return transcriptPath;
  return resolve(vaultRoot, transcriptPath);
}

async function readTranscriptFile(absolutePath: string, displayPath: string): Promise<string> {
  try {
    return await readFile(absolutePath, "utf-8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (reason.includes("ENOENT")) {
      throw new Error(`transcript file not found: ${displayPath}`);
    }
    throw new Error(`failed to read transcript ${displayPath}: ${reason}`);
  }
}

interface WriteProposalsOptions {
  vaultRoot: string;
  candidates: Candidate[];
  transcriptPath: string;
  clientIdentity: string;
}

async function writeProposalFiles(options: WriteProposalsOptions): Promise<number> {
  if (options.candidates.length === 0) return 0;
  const proposalsDir = join(options.vaultRoot, PROPOSALS_FOLDER);
  await mkdir(proposalsDir, { recursive: true });
  const createdAt = Date.now();
  let written = 0;
  for (let index = 0; index < options.candidates.length; index++) {
    const candidate = options.candidates[index];
    const seq = index + 1;
    const filename = `distilled-${createdAt}-${candidate.kind}-${seq}.md`;
    const body = renderProposalBody({
      candidate,
      transcriptPath: options.transcriptPath,
      clientIdentity: options.clientIdentity,
      createdAt,
    });
    await writeFile(join(proposalsDir, filename), body, "utf-8");
    written++;
  }
  return written;
}

interface RenderProposalOptions {
  candidate: Candidate;
  transcriptPath: string;
  clientIdentity: string;
  createdAt: number;
}

function renderProposalBody(options: RenderProposalOptions): string {
  const title = buildTitle(options.candidate.text);
  const frontmatterLines: string[] = [
    "---",
    `kind: ${options.candidate.kind}`,
    `sourceTranscript: ${escapeYamlScalar(options.transcriptPath)}`,
    `clientIdentity: ${escapeYamlScalar(options.clientIdentity)}`,
    "sourceMessageIds:",
  ];
  if (options.candidate.sourceMessageIds.length === 0) {
    frontmatterLines.push("  []");
  } else {
    for (const id of options.candidate.sourceMessageIds) {
      frontmatterLines.push(`  - ${escapeYamlScalar(id)}`);
    }
  }
  frontmatterLines.push(`createdAt: ${options.createdAt}`);
  frontmatterLines.push("---");
  frontmatterLines.push("");
  frontmatterLines.push(`# ${title}`);
  frontmatterLines.push("");
  frontmatterLines.push(options.candidate.text);
  frontmatterLines.push("");
  return frontmatterLines.join("\n");
}

function buildTitle(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const sliced =
    collapsed.length > TITLE_MAX_CHARS ? collapsed.slice(0, TITLE_MAX_CHARS) : collapsed;
  return sliced.replace(/[.,;:!?]+$/u, "").trim();
}

function escapeYamlScalar(input: string): string {
  if (/^[\w./@-][\w./@ -]*$/.test(input)) return input;
  const escaped = input.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function tallyByKind(candidates: Candidate[]): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const candidate of candidates) {
    tally[candidate.kind] = (tally[candidate.kind] ?? 0) + 1;
  }
  return tally;
}

export type { TranscriptMessage };
