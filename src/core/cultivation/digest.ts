import type { VaultAdapter } from "../../adapters/vaultAdapter";
import type {
  CultivationDigestItem,
  CultivationOrigin,
  CultivationQuietResult,
} from "../../api/cultivation";
import { contentRevision, inspectMarkdown, NoteReadService } from "../../api/notes";
import { sourceRange } from "../../api/notes";
import type { PipelineJob } from "../../api/pipelines";
import { scopeAllows } from "../../api/scope";
import { scopeSchema } from "../../api/operations";
import type { NoteScope } from "../../api/scope";
import type { NoteReference, SourceReference } from "../../api/schema";
import type { PipelineFinding } from "../../api/pipelines";
import {
  appendedIntelligenceRecords,
  canContinueSection,
  parseAllIntelligenceRecords,
  withoutRetainedIntelligence,
} from "../intelligence";
import { assessPipelineFinding } from "../pipelines/intelligenceAssessment";

export interface CultivationDigestOptions {
  vault: VaultAdapter;
  jobs: readonly PipelineJob[];
  currentScopes: Record<PipelineJob["pipeline"], NoteScope>;
  requestedScope?: NoteScope;
  activeNotePath: string | null;
  now: number;
  limit: number;
}

interface DigestCandidate {
  item: CultivationDigestItem;
  score: number;
  identity: string;
}

export async function createCultivationDigest(
  options: CultivationDigestOptions,
): Promise<CultivationDigestItem[]> {
  const reader = new NoteReadService(options.vault);
  const cache = new Map<string, Awaited<ReturnType<NoteReadService["read"]>> | null>();
  const requestedScope = options.requestedScope ?? scopeSchema.parse({});
  const currentJobs = options.jobs
    .filter((job) => job.plan !== null)
    .sort((left, right) => right.updatedAt - left.updatedAt);
  const candidates: DigestCandidate[] = [];
  const seen = new Set<string>();
  let checkedReferences = 0;
  const referenceLimit = options.limit * 30 * 4;

  for (const job of currentJobs) {
    if (!job.plan) continue;
    const disposition = dispositionFor(job);
    if (job.state === "cancelled" && disposition !== "applied") continue;
    for (const [index, finding] of job.plan.findings.entries()) {
      if (checkedReferences + finding.evidence.length + (finding.target ? 1 : 0) > referenceLimit)
        return pick(candidates, options.limit);
      const evidence: SourceReference[] = [];
      const currentNotes = new Map<string, Awaited<ReturnType<NoteReadService["read"]>>>();
      let available = true;
      for (const reference of finding.evidence) {
        checkedReferences += 1;
        const note = await readCurrent(reader, cache, reference);
        if (
          note === null ||
          !scopeAllows(job.policy.readScope, note.note.path, note.structure.tags) ||
          !scopeAllows(options.currentScopes[job.pipeline], note.note.path, note.structure.tags) ||
          !scopeAllows(requestedScope, note.note.path, note.structure.tags) ||
          !supportsQuote(note.body, reference)
        ) {
          available = false;
          break;
        }
        const current = rebindReference(note, reference);
        if (current) {
          evidence.push(current);
          currentNotes.set(note.note.path, note);
        }
      }
      if (!available || evidence.length !== finding.evidence.length) continue;
      const evidencePaths = new Set(evidence.map((source) => source.path));
      const appliedRecipient = job.effects?.effects.find(
        (effect) => effect.state === "applied" && evidencePaths.has(effect.path),
      )?.path;
      const plannedRecipient = job.plan.changes.find(
        (change) =>
          change.kind === "append" &&
          finding.evidence.some((source) => source.path === change.source.path),
      );
      const selectedRecipient = job.sourceRevisions.find((source) =>
        evidencePaths.has(source.path),
      );
      const routePath =
        finding.target?.path ??
        appliedRecipient ??
        (plannedRecipient?.kind === "append" ? plannedRecipient.source.path : undefined) ??
        selectedRecipient?.path ??
        evidence[0]?.path;
      let route = routePath ? (currentNotes.get(routePath) ?? null) : null;
      if (!route && finding.target) {
        checkedReferences += 1;
        route = await readCurrent(reader, cache, finding.target);
        if (
          route &&
          (!scopeAllows(job.policy.readScope, route.note.path, route.structure.tags) ||
            !scopeAllows(
              options.currentScopes[job.pipeline],
              route.note.path,
              route.structure.tags,
            ) ||
            !scopeAllows(requestedScope, route.note.path, route.structure.tags))
        )
          route = null;
      }
      if (!route) continue;
      const assessment = assessDigestFinding(job, finding, currentNotes);
      const identity = JSON.stringify([
        route.note.path,
        finding.kind,
        finding.title.trim().toLowerCase(),
        evidence.map((source) => [
          source.path,
          source.revision,
          source.range.start,
          source.range.end,
        ]),
      ]);
      if (seen.has(identity)) continue;
      seen.add(identity);
      const itemDisposition = dispositionForPath(job, route.note.path, disposition);
      const reasons = relevanceReasons(
        job,
        finding.kind,
        route.note.path,
        options.activeNotePath,
        itemDisposition,
        assessment.status,
      );
      candidates.push({
        identity,
        score: digestScore(
          job,
          finding.kind,
          route.note.path,
          options.activeNotePath,
          itemDisposition,
          options.now,
        ),
        item: {
          id: `${job.id}:${index}`,
          jobId: job.id,
          pipeline: job.pipeline,
          disposition: itemDisposition,
          status: assessment.status,
          title: finding.title,
          explanation: assessment.statement,
          qualifications: assessment.qualifications,
          path: route.note.path,
          revision: route.note.revision,
          evidence,
          reasons,
          origin: jobOrigin(job),
          createdAt: job.createdAt,
          updatedAt: job.updatedAt,
        },
      });
    }
  }
  return pick(candidates, options.limit);
}

async function readCurrent(
  reader: NoteReadService,
  cache: Map<string, Awaited<ReturnType<NoteReadService["read"]>> | null>,
  reference: NoteReference,
): Promise<Awaited<ReturnType<NoteReadService["read"]>> | null> {
  const key = reference.path;
  if (cache.has(key)) return cache.get(key) ?? null;
  try {
    const result = await reader.read({ path: reference.path });
    cache.set(key, result);
    return result;
  } catch {
    cache.set(key, null);
    return null;
  }
}

function supportsQuote(body: string, reference: SourceReference): boolean {
  const authored = withoutRetainedIntelligence(body);
  return (
    authored.slice(reference.range.start, reference.range.end) === reference.quote ||
    findUniqueQuote(authored, reference.quote) !== null
  );
}

function rebindReference(
  note: Awaited<ReturnType<NoteReadService["read"]>>,
  reference: SourceReference,
): SourceReference | null {
  const authored = withoutRetainedIntelligence(note.body);
  let start =
    authored.slice(reference.range.start, reference.range.end) === reference.quote
      ? reference.range.start
      : findUniqueQuote(authored, reference.quote);
  if (start === null) return null;
  const range = sourceRange(note.body, start, start + reference.quote.length);
  if (note.body.slice(range.start, range.end) !== reference.quote) return null;
  return { path: note.note.path, revision: note.note.revision, range, quote: reference.quote };
}

function assessDigestFinding(
  job: PipelineJob,
  finding: PipelineFinding,
  currentNotes: ReadonlyMap<string, Awaited<ReturnType<NoteReadService["read"]>>>,
): { status: CultivationDigestItem["status"]; statement: string; qualifications: string[] } {
  const documents: Array<Awaited<ReturnType<NoteReadService["read"]>>> = [];
  for (const reference of finding.evidence) {
    const current = currentNotes.get(reference.path);
    if (!current) return staleAssessment(finding);
    if (current.note.revision === reference.revision) {
      documents.push(current);
      continue;
    }
    const applied = job.effects?.effects.some(
      (effect) => effect.path === reference.path && effect.state === "applied",
    );
    const append = applied
      ? job.plan?.changes.find(
          (change) =>
            change.kind === "append" &&
            change.source.path === reference.path &&
            change.source.revision === reference.revision &&
            change.text.length > 0 &&
            current.body.endsWith(change.text),
        )
      : undefined;
    if (!append || append.kind !== "append") return staleAssessment(finding);
    const headings = new Set(job.policy.allowedSections.map((section) => `## ${section}`));
    const residue = withoutRetainedIntelligence(append.text).split(/\r?\n/u);
    const originalBody = current.body.slice(0, -append.text.length);
    if (contentRevision(originalBody) !== reference.revision) return staleAssessment(finding);
    const headed = residue.some((line) => headings.has(line.trim()));
    let retained = 0;
    try {
      retained = headed
        ? parseAllIntelligenceRecords(append.text).length
        : job.policy.allowedSections.some((section) => canContinueSection(originalBody, section))
          ? appendedIntelligenceRecords(originalBody, append.text).length
          : 0;
    } catch {
      return staleAssessment(finding);
    }
    if (
      retained === 0 ||
      residue.some((line) => line.trim().length > 0 && !headings.has(line.trim()))
    )
      return staleAssessment(finding);
    documents.push({
      ...current,
      note: { ...current.note, revision: reference.revision },
      body: originalBody,
      structure: inspectMarkdown(originalBody),
    });
  }
  const assessment = assessPipelineFinding(finding, documents, finding.kind === "relationship");
  return {
    status: assessment.status,
    statement: assessment.statement,
    qualifications: assessment.qualifications,
  };
}

function staleAssessment(finding: PipelineFinding): {
  status: CultivationDigestItem["status"];
  statement: string;
  qualifications: string[];
} {
  return {
    status: finding.kind === "question" ? "open" : "provisional",
    statement: finding.explanation,
    qualifications: [
      finding.kind === "question"
        ? "This question remains open. The source revision changed; its quoted passages remain in current authored text, so inspect the changed context before resolving it."
        : "The source revision changed after this finding was assessed. Its quoted passages remain in current authored text, but the earlier semantic assessment remains provisional in the changed context.",
      ...(finding.qualifications ?? []),
    ].slice(0, 20),
  };
}

function findUniqueQuote(body: string, quote: string): number | null {
  if (!quote) return null;
  const first = body.indexOf(quote);
  if (first < 0 || body.indexOf(quote, first + 1) >= 0) return null;
  return first;
}

function dispositionFor(job: PipelineJob): CultivationDigestItem["disposition"] {
  if (job.effects?.state === "applied") return "applied";
  if (job.effects?.state === "partial") return "partial";
  if (job.state === "awaiting-approval" || job.proposalIds.length > 0) return "awaiting-review";
  return "report-only";
}

function dispositionForPath(
  job: PipelineJob,
  path: string,
  fallback: CultivationDigestItem["disposition"],
): CultivationDigestItem["disposition"] {
  if (job.effects?.state === "applied")
    return job.effects.effects.some((effect) => effect.path === path && effect.state === "applied")
      ? "applied"
      : "report-only";
  if (job.effects?.state === "partial")
    return job.effects.effects.some((effect) => effect.path === path && effect.state === "applied")
      ? "applied"
      : "partial";
  return fallback;
}

function relevanceReasons(
  job: PipelineJob,
  kind: string,
  path: string,
  activeNotePath: string | null,
  disposition: CultivationDigestItem["disposition"],
  status: CultivationDigestItem["status"],
): string[] {
  const reasons: string[] = [];
  if (path === activeNotePath) reasons.push("This note is currently in focus.");
  if (job.reason.includes("save trigger"))
    reasons.push("A saved contribution triggered this cultivation run.");
  if (["contradiction", "temporal-change", "different-assumptions"].includes(kind))
    reasons.push("The evidence may change how a retained conclusion should be read.");
  else if (kind === "question") reasons.push("The source evidence raises an unresolved question.");
  else if (kind === "relationship")
    reasons.push("A connection between the notes is available to inspect.");
  if (status === "supported")
    reasons.push(
      "A separate semantic assessment supports this bounded statement; source truth is not externally verified.",
    );
  else if (status === "provisional")
    reasons.push(
      "This finding remains provisional; review its qualifications before relying on it.",
    );
  if (disposition === "awaiting-review") reasons.push("A proposed change is waiting for review.");
  if (disposition === "applied")
    reasons.push("The change was retained on this note and can be read there.");
  return reasons.slice(0, 8);
}

function digestScore(
  job: PipelineJob,
  kind: string,
  path: string,
  activeNotePath: string | null,
  disposition: CultivationDigestItem["disposition"],
  now: number,
): number {
  const ageHours = Math.max(0, now - job.updatedAt) / 3_600_000;
  return (
    (path === activeNotePath ? 12 : 0) +
    7 * Math.exp(-ageHours / 72) +
    (job.reason.includes("save trigger") ? 4 : 0) +
    (kind === "question" ? 3 : 0) +
    (["contradiction", "temporal-change", "different-assumptions"].includes(kind) ? 2 : 0) +
    (disposition === "awaiting-review" ? 5 : disposition === "applied" ? 1 : 0)
  );
}

function pick(candidates: DigestCandidate[], limit: number): CultivationDigestItem[] {
  return candidates
    .sort((left, right) => right.score - left.score || right.item.updatedAt - left.item.updatedAt)
    .slice(0, limit)
    .map((candidate) => candidate.item);
}

export function jobOrigin(job: PipelineJob): CultivationOrigin {
  const trigger = job.reason.startsWith("save trigger")
    ? "save"
    : job.reason.startsWith("idle trigger")
      ? "idle"
      : job.reason.startsWith("interval trigger")
        ? "interval"
        : job.pipeline === "reconsider"
          ? "reconsider"
          : "manual";
  return {
    trigger,
    caller: job.caller.id,
    examined: job.sourceRevisions.slice(0, 20).map((source) => source.path),
  };
}

const QUIET_WINDOW_MS = 7 * 86_400_000;
const QUIET_EXEMPT = new Set<PipelineJob["pipeline"]>(["index-extract", "reconsider"]);

export function createQuietResults(options: {
  jobs: readonly PipelineJob[];
  currentScopes: Record<PipelineJob["pipeline"], NoteScope>;
  requestedScope?: NoteScope;
  now: number;
  limit: number;
}): CultivationQuietResult[] {
  const requestedScope = options.requestedScope ?? scopeSchema.parse({});
  const results: CultivationQuietResult[] = [];
  const sorted = [...options.jobs].sort((left, right) => right.updatedAt - left.updatedAt);
  for (const job of sorted) {
    if (results.length >= options.limit) break;
    if (!job.background || QUIET_EXEMPT.has(job.pipeline)) continue;
    if (options.now - job.updatedAt > QUIET_WINDOW_MS) continue;
    const examined = job.sourceRevisions.filter(
      (source) =>
        scopeAllows(job.policy.readScope, source.path, []) &&
        scopeAllows(options.currentScopes[job.pipeline], source.path, []) &&
        scopeAllows(requestedScope, source.path, []),
    );
    if (job.sourceRevisions.length > 0 && examined.length === 0) continue;
    const origin = { ...jobOrigin(job), examined: examined.slice(0, 20).map((source) => source.path) };
    if (job.state === "failed" && job.failure) {
      results.push({
        jobId: job.id,
        pipeline: job.pipeline,
        outcome: "failed",
        reason: `The run stopped before producing a result: ${job.failure.message}`.slice(0, 2000),
        origin,
        updatedAt: job.updatedAt,
      });
      continue;
    }
    if (job.state !== "completed" || !job.plan) continue;
    if (job.plan.findings.length > 0 || job.plan.changes.length > 0 || job.plan.relationships.length > 0)
      continue;
    results.push({
      jobId: job.id,
      pipeline: job.pipeline,
      outcome: "no-write",
      reason: (
        job.plan.reason ??
        (job.plan.abstained ? job.plan.summary : `Nothing worth retaining was found. ${job.plan.summary}`)
      ).slice(0, 2000),
      origin,
      updatedAt: job.updatedAt,
    });
  }
  return results;
}
