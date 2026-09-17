/**
 * Agent-verb end-to-end CLI smoke harness.
 *
 * Drives the daemon RPC against a fixture-vault copy and whatever
 * OpenAI-compatible substrate the operator configured, exercising the agent
 * verbs: `chat --as`, `ask`, `brief` (topic and file forms), `session
 * grant/list/revoke`, `distill --dry-run`, `distill` (live), and `events`.
 * The endpoint and model ids come from `NOTIENT_LLM_BASE_URL`,
 * `NOTIENT_LLM_MODEL`, and `NOTIENT_EMBED_MODEL` (see
 * `tools/lib/spawnEnv.ts`). The harness mirrors the structural shape of
 * `tools/smoke-cli-core.ts`: capture the project-root NOTIENT_* deployment
 * values before stripping them from child processes, mkdtemp the fixture,
 * init, write one complete canonical product config, awaken, then run each
 * verb pass.
 *
 * Each pass that the model cannot reliably drive (substrate-flaky outputs)
 * emits `smoke:<step>_skipped` instead of failing. Deterministic contract
 * checks remain hard failures. Pass-by-pass classification:
 *
 *   identity_validated      - hard assertion (deterministic disk read)
 *   ask_validated/skipped   - skip-tolerant (substrate may not surface citations)
 *   brief_topic_v/skipped   - skip-tolerant (relevantNotes is substrate-driven)
 *   brief_file_v/skipped    - skip-tolerant (summary OR relevantNotes path)
 *   session_grant_validated - hard assertion (deterministic SQL row)
 *   distill_dry_v/skipped   - skip-tolerant (LLM may extract zero candidates)
 *   distill_live_v/skipped  - skip-tolerant (depends on dry-run outcome)
 *   events_validated/skip   - skip-tolerant (chat may not fire swarm events)
 *   session_revoke_validated - hard assertion (deterministic SQL row)
 *
 * Skips are not failures; the smoke continues so a later regression is not
 * masked by an earlier skip. Outright failures raise, emit `smoke:fatal`,
 * and exit 1.
 */

import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEmitter } from "../src/cli/output";
import { parseAgentEventRecordId } from "../src/core/services/agentEventStore";
import { parseSessionGrantRecordId } from "../src/core/services/sessionGrants";
import { parseNotientConfig } from "../src/core/settings/configSchema";
import { DEFAULT_NOTIENT_CONFIG } from "../src/core/settings/types";
import {
  buildSmokeEnv,
  captureNotientEnv,
  stripNotientEnvFromProcess,
  writeVaultEnvFile,
} from "./lib/spawnEnv";

const emitter = makeEmitter({ mode: "ndjson" });
const SMOKE_TIMEOUT_MS = 240_000;
const CONVERSATIONS_FOLDER = "Notient/conversations";
const PROPOSALS_FOLDER = "Notient/proposals";
const SMOKE_CLIENT_IDENTITY = "claude-code";
const FIXTURE_BRIEF_FILE = "notes/TDD discipline.md";

async function main(): Promise<void> {
  const envSnapshot = captureNotientEnv();
  stripNotientEnvFromProcess();
  const fixtureRoot = join(process.cwd(), "testing", "fixtures", "sentient-vault");
  const tmpRoot = await mkdtemp(join(tmpdir(), "notient-smoke-agents-"));
  try {
    await cp(fixtureRoot, tmpRoot, { recursive: true });
    emitter.emit({ type: "smoke:setup", tmpRoot });

    await runOneShot(["init", tmpRoot]);
    await writeVaultEnvFile(tmpRoot, envSnapshot);
    emitter.emit({ type: "smoke:init_done" });

    await preSeedConfig(tmpRoot);
    emitter.emit({ type: "smoke:config_seeded" });

    await runOneShot(["awaken", "--vault", tmpRoot]);
    emitter.emit({ type: "smoke:awaken_done" });

    await runIdentityPass(tmpRoot);

    await runAskPass(tmpRoot);

    await runBriefTopicPass(tmpRoot);

    await runBriefFilePass(tmpRoot);

    const sessionId = await runSessionGrantPass(tmpRoot);

    const distillRanLive = await runDistillPass(tmpRoot);

    await runEventsPass(tmpRoot, distillRanLive);

    await runSessionRevokePass(tmpRoot, sessionId);

    await runOneShot(["daemon", "stop", "--vault", tmpRoot]);
    emitter.emit({ type: "smoke:complete" });
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

interface CapturedFrames {
  exitCode: number;
  stdout: string[];
  stderr: string[];
}

async function runOneShot(argv: string[]): Promise<void> {
  const captured = await runOneShotCollect(argv);
  if (captured.exitCode !== 0) {
    emitter.emit({
      type: "smoke:error",
      argv,
      exitCode: captured.exitCode,
      stderr: captured.stderr.join("\n"),
    });
    throw new Error(`Command failed: notient ${argv.join(" ")}`);
  }
}

async function runOneShotCollect(argv: string[]): Promise<CapturedFrames> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--env-file=/dev/null", "run", "src/cli/index.ts", ...argv, "--ndjson"],
      { stdio: ["ignore", "pipe", "pipe"], env: buildSmokeEnv() },
    );
    const stdoutBuffer: string[] = [];
    const stderrBuffer: string[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`smoke timeout after ${SMOKE_TIMEOUT_MS}ms running ${argv.join(" ")}`));
    }, SMOKE_TIMEOUT_MS);
    child.stdout.on("data", (data: Buffer) => {
      stdoutBuffer.push(data.toString("utf-8"));
    });
    child.stderr.on("data", (data: Buffer) => {
      stderrBuffer.push(data.toString("utf-8"));
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        exitCode: exitCode ?? -1,
        stdout: stdoutBuffer.join("").split("\n").filter(Boolean),
        stderr: stderrBuffer.join("").split("\n").filter(Boolean),
      });
    });
  });
}

/**
 * Write the exact current persisted shape before daemon spawn. Constructing
 * the whole config from the canonical default prevents partial input or
 * retired keys from surviving in the smoke fixture.
 */
async function preSeedConfig(vaultPath: string): Promise<void> {
  const configPath = join(vaultPath, ".notient", "config.json");
  await mkdir(join(vaultPath, ".notient"), { recursive: true });
  const candidate = structuredClone(DEFAULT_NOTIENT_CONFIG);
  const raw = `${JSON.stringify(candidate, null, 2)}\n`;
  parseNotientConfig(raw, configPath);
  await writeFile(configPath, raw);
}

/**
 * Parse the JSON pretty-printed payload that `--ndjson` mode renders for
 * the structured commands (ask, brief, distill, session). The CLI writes
 * these verbs' payloads as multi-line `JSON.stringify(payload, null, 2)`,
 * so the captured stdout has one logical JSON object spanning many lines
 * rather than one NDJSON frame per line. parseStructuredPayload joins
 * stdout, locates the outermost `{...}` span, and parses it.
 */
function parseStructuredPayload(captured: CapturedFrames): Record<string, unknown> {
  if (captured.exitCode !== 0) {
    throw new Error(`command failed (exit ${captured.exitCode}): ${captured.stderr.join("\n")}`);
  }
  const joined = captured.stdout.join("\n");
  const start = joined.indexOf("{");
  const end = joined.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`structured payload not found in stdout: ${joined.slice(0, 200)}`);
  }
  const slice = joined.slice(start, end + 1);
  return JSON.parse(slice) as Record<string, unknown>;
}

async function runIdentityPass(vaultPath: string): Promise<void> {
  await runOneShot([
    "chat",
    "What is the purpose of this vault? Reply in one sentence.",
    "--as",
    SMOKE_CLIENT_IDENTITY,
    "--vault",
    vaultPath,
    "--approve",
    "auto",
  ]);
  const conversationsDir = join(vaultPath, CONVERSATIONS_FOLDER);
  const entries = await readdir(conversationsDir);
  const markdownFiles = entries.filter((name) => name.endsWith(".md"));
  if (markdownFiles.length === 0) {
    throw new Error(`identity: no conversation files in ${conversationsDir} after chat call`);
  }
  const newest = await pickNewestFile(conversationsDir, markdownFiles);
  const body = await readFile(join(conversationsDir, newest), "utf-8");
  const frontmatter = extractFrontmatter(body);
  const identityLine = frontmatter.split("\n").find((line) => line.startsWith("client_identity:"));
  if (identityLine === undefined) {
    throw new Error(`identity: client_identity not present in frontmatter of ${newest}`);
  }
  const expected = `client_identity: ${JSON.stringify(SMOKE_CLIENT_IDENTITY)}`;
  if (identityLine.trim() !== expected) {
    throw new Error(
      `identity: expected '${expected}' but found '${identityLine.trim()}' in ${newest}`,
    );
  }
  emitter.emit({ type: "smoke:identity_validated", file: newest });
}

async function pickNewestFile(directory: string, names: string[]): Promise<string> {
  let newest = names[0];
  let newestMtime = 0;
  for (const name of names) {
    const stat = await Bun.file(join(directory, name)).stat();
    const mtime = stat.mtimeMs ?? 0;
    if (mtime >= newestMtime) {
      newestMtime = mtime;
      newest = name;
    }
  }
  return newest;
}

function extractFrontmatter(markdown: string): string {
  if (!markdown.startsWith("---\n")) return "";
  const end = markdown.indexOf("\n---", 4);
  if (end === -1) return "";
  return markdown.slice(4, end);
}

async function runAskPass(vaultPath: string): Promise<void> {
  const captured = await runOneShotCollect([
    "ask",
    "what is this vault about?",
    "--as",
    SMOKE_CLIENT_IDENTITY,
    "--vault",
    vaultPath,
  ]);
  const payload = parseStructuredPayload(captured);
  const answer = payload.answer;
  if (typeof answer !== "string" || answer.length === 0) {
    throw new Error(`ask: expected non-empty string answer, got ${typeof answer}`);
  }
  const citations = Array.isArray(payload.citations) ? payload.citations : [];
  if (citations.length === 0) {
    emitter.emit({
      type: "smoke:ask_skipped",
      reason: "substrate did not surface citations",
      answerChars: answer.length,
    });
    return;
  }
  emitter.emit({
    type: "smoke:ask_validated",
    citations: citations.length,
    answerChars: answer.length,
  });
}

async function runBriefTopicPass(vaultPath: string): Promise<void> {
  const captured = await runOneShotCollect([
    "brief",
    "TDD",
    "--as",
    SMOKE_CLIENT_IDENTITY,
    "--vault",
    vaultPath,
  ]);
  const payload = parseStructuredPayload(captured);
  const relevantNotes = Array.isArray(payload.relevantNotes) ? payload.relevantNotes : null;
  if (relevantNotes === null) {
    throw new Error("brief topic: relevantNotes missing or not an array");
  }
  if (relevantNotes.length === 0) {
    emitter.emit({
      type: "smoke:brief_topic_skipped",
      reason: "substrate returned zero relevant notes for topic 'TDD'",
    });
    return;
  }
  emitter.emit({ type: "smoke:brief_topic_validated", relevantNotes: relevantNotes.length });
}

async function runBriefFilePass(vaultPath: string): Promise<void> {
  const captured = await runOneShotCollect([
    "brief",
    "--file",
    FIXTURE_BRIEF_FILE,
    "--as",
    SMOKE_CLIENT_IDENTITY,
    "--vault",
    vaultPath,
  ]);
  const payload = parseStructuredPayload(captured);
  const summary = typeof payload.summary === "string" ? payload.summary : "";
  const relevantNotes = Array.isArray(payload.relevantNotes) ? payload.relevantNotes : [];
  if (summary.length > 0) {
    emitter.emit({
      type: "smoke:brief_file_validated",
      file: FIXTURE_BRIEF_FILE,
      summaryChars: summary.length,
    });
    return;
  }
  if (relevantNotes.length > 0) {
    emitter.emit({
      type: "smoke:brief_file_validated",
      file: FIXTURE_BRIEF_FILE,
      relevantNotes: relevantNotes.length,
    });
    return;
  }
  emitter.emit({
    type: "smoke:brief_file_skipped",
    reason: "substrate returned neither summary nor relevant notes",
    file: FIXTURE_BRIEF_FILE,
  });
}

async function runSessionGrantPass(vaultPath: string): Promise<string> {
  const grantCaptured = await runOneShotCollect([
    "session",
    "grant",
    "--client",
    SMOKE_CLIENT_IDENTITY,
    "--folders",
    "Inbox/",
    "--max-writes",
    "5",
    "--ttl",
    "60",
    "--vault",
    vaultPath,
  ]);
  const grantPayload = parseStructuredPayload(grantCaptured);
  const sessionIdRaw = grantPayload.sessionId;
  let sessionId: string;
  try {
    sessionId = parseSessionGrantRecordId(sessionIdRaw).toString();
  } catch {
    throw new Error(
      `session grant: expected canonical agent_session id, got ${String(sessionIdRaw)}`,
    );
  }
  const listCaptured = await runOneShotCollect(["session", "list", "--vault", vaultPath]);
  const listPayload = parseStructuredPayload(listCaptured);
  const sessions = Array.isArray(listPayload.sessions) ? listPayload.sessions : [];
  const found = sessions.some(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as { sessionId?: unknown }).sessionId === sessionId,
  );
  if (!found) {
    throw new Error(
      `session grant: sessionId ${sessionId} not found in session list (${sessions.length} entries)`,
    );
  }
  emitter.emit({ type: "smoke:session_grant_validated", sessionId });
  return sessionId;
}

async function runDistillPass(vaultPath: string): Promise<boolean> {
  const transcriptPath = join(vaultPath, "transcript.md");
  const transcript = [
    "User: I keep coming back to this question of caching strategy.",
    "Assistant: A two-tier cache works: hot data in memory, warm data on disk.",
    "User: Decision: we use Redis for the hot tier.",
    "Assistant: Got it. Are there cases where the disk tier should bypass Redis?",
    "",
  ].join("\n");
  await writeFile(transcriptPath, transcript, "utf-8");

  const dryCaptured = await runOneShotCollect([
    "distill",
    "--from",
    transcriptPath,
    "--as",
    SMOKE_CLIENT_IDENTITY,
    "--dry-run",
    "--vault",
    vaultPath,
  ]);
  const dryPayload = parseStructuredPayload(dryCaptured);
  const dryCandidates = Array.isArray(dryPayload.candidates) ? dryPayload.candidates : [];
  const dryProposalsCreated = dryPayload.proposalsCreated;
  if (dryProposalsCreated !== 0) {
    throw new Error(
      `distill dry-run: expected proposalsCreated=0, got ${String(dryProposalsCreated)}`,
    );
  }
  if (dryCandidates.length === 0) {
    emitter.emit({
      type: "smoke:distill_dry_skipped",
      reason: "substrate extracted zero candidates from the four-line transcript",
    });
    emitter.emit({
      type: "smoke:distill_live_skipped",
      reason: "dry-run produced no candidates so live run was not exercised",
    });
    return false;
  }
  emitter.emit({ type: "smoke:distill_dry_validated", candidates: dryCandidates.length });

  const liveCaptured = await runOneShotCollect([
    "distill",
    "--from",
    transcriptPath,
    "--as",
    SMOKE_CLIENT_IDENTITY,
    "--vault",
    vaultPath,
  ]);
  const livePayload = parseStructuredPayload(liveCaptured);
  const liveProposalsCreatedRaw = livePayload.proposalsCreated;
  const liveProposalsCreated =
    typeof liveProposalsCreatedRaw === "number" ? liveProposalsCreatedRaw : 0;
  if (liveProposalsCreated < 1) {
    throw new Error(`distill live: expected proposalsCreated >= 1, got ${liveProposalsCreated}`);
  }
  const proposalsDir = join(vaultPath, PROPOSALS_FOLDER);
  const proposalEntries = await readdir(proposalsDir);
  const distilledFiles = proposalEntries.filter(
    (name) => name.startsWith("distilled-") && name.endsWith(".md"),
  );
  if (distilledFiles.length === 0) {
    throw new Error(`distill live: no distilled-*.md files found in ${proposalsDir}`);
  }
  const sample = await readFile(join(proposalsDir, distilledFiles[0]), "utf-8");
  const sampleFrontmatter = extractFrontmatter(sample);
  if (!sampleFrontmatter.includes("kind:")) {
    throw new Error(
      `distill live: proposal frontmatter missing 'kind:' (file=${distilledFiles[0]})`,
    );
  }
  if (!sampleFrontmatter.includes("sourceTranscript:")) {
    throw new Error(
      `distill live: proposal frontmatter missing 'sourceTranscript:' (file=${distilledFiles[0]})`,
    );
  }
  if (!sampleFrontmatter.includes(`clientIdentity: ${SMOKE_CLIENT_IDENTITY}`)) {
    throw new Error(
      `distill live: proposal frontmatter missing 'clientIdentity: ${SMOKE_CLIENT_IDENTITY}' (file=${distilledFiles[0]})`,
    );
  }
  emitter.emit({
    type: "smoke:distill_live_validated",
    proposalsCreated: liveProposalsCreated,
    sample: distilledFiles[0],
  });
  return true;
}

async function runEventsPass(vaultPath: string, distillRanLive: boolean): Promise<void> {
  const baselineCaptured = await runOneShotCollect(["events", "--no-poll", "--vault", vaultPath]);
  if (baselineCaptured.exitCode !== 0) {
    throw new Error(
      `events baseline: exit ${baselineCaptured.exitCode}: ${baselineCaptured.stderr.join("\n")}`,
    );
  }
  const baselineCursor = parseEventsCursor(baselineCaptured.stdout);

  // Drive an additional chat turn to give the swarm a chance to fire events
  // beyond the baseline cursor. Reuse the same prompt-shape as the identity
  // pass so the smoke does not depend on a vault-specific intent.
  await runOneShot([
    "chat",
    "List two reasons developers should keep notes. Reply briefly.",
    "--as",
    SMOKE_CLIENT_IDENTITY,
    "--vault",
    vaultPath,
    "--approve",
    "auto",
  ]);

  const followArgs = ["events", "--no-poll", "--vault", vaultPath];
  if (baselineCursor !== null) followArgs.splice(1, 0, "--since", baselineCursor);
  const followCaptured = await runOneShotCollect(followArgs);
  if (followCaptured.exitCode !== 0) {
    throw new Error(
      `events follow-up: exit ${followCaptured.exitCode}: ${followCaptured.stderr.join("\n")}`,
    );
  }
  const newEvents = parseEventLines(followCaptured.stdout);
  if (newEvents.length === 0) {
    emitter.emit({
      type: "smoke:events_skipped",
      reason: "substrate did not fire swarm events beyond the baseline cursor",
      baselineCursor,
      distillRanLive,
    });
    return;
  }
  emitter.emit({
    type: "smoke:events_validated",
    count: newEvents.length,
    baselineCursor,
  });
}

function parseEventsCursor(lines: string[]): string | null {
  for (let index = lines.length - 1; index >= 0; index--) {
    const raw = lines[index];
    const parsed = parseJsonLine(raw, "events cursor");
    if (parsed.type !== "events:cursor") continue;
    if (parsed.cursor === null) return null;
    try {
      return parseAgentEventRecordId(parsed.cursor).toString();
    } catch {
      throw new Error(`events: invalid cursor ${String(parsed.cursor)}`);
    }
  }
  throw new Error("events: no events:cursor frame in output");
}

function parseEventLines(lines: string[]): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const raw of lines) {
    const parsed = parseJsonLine(raw, "events output");
    if (parsed.type === "events:cursor") continue;
    events.push(parsed);
  }
  return events;
}

function parseJsonLine(raw: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${label}: invalid JSON line`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label}: JSON line is not an object`);
  }
  return parsed as Record<string, unknown>;
}

async function runSessionRevokePass(vaultPath: string, sessionId: string): Promise<void> {
  const revokeCaptured = await runOneShotCollect([
    "session",
    "revoke",
    String(sessionId),
    "--vault",
    vaultPath,
  ]);
  const revokePayload = parseStructuredPayload(revokeCaptured);
  if (revokePayload.sessionId !== sessionId) {
    throw new Error(
      `session revoke: expected sessionId=${sessionId}, got ${String(revokePayload.sessionId)}`,
    );
  }
  if (typeof revokePayload.revokedAt !== "number" || revokePayload.revokedAt <= 0) {
    throw new Error(
      `session revoke: expected positive revokedAt timestamp, got ${String(revokePayload.revokedAt)}`,
    );
  }
  const listCaptured = await runOneShotCollect(["session", "list", "--vault", vaultPath]);
  const listPayload = parseStructuredPayload(listCaptured);
  const sessions = Array.isArray(listPayload.sessions) ? listPayload.sessions : [];
  const stillPresent = sessions.some(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as { sessionId?: unknown }).sessionId === sessionId,
  );
  if (stillPresent) {
    throw new Error(
      `session revoke: sessionId ${sessionId} still appears in active session list after revoke`,
    );
  }
  emitter.emit({ type: "smoke:session_revoke_validated", sessionId });
}

void main().catch((error) => {
  emitter.emit({
    type: "smoke:fatal",
    message: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
