import type { MethodologySuggestionResult } from "../../api/methodology";
import type { MethodologySettings } from "../../api/cultivationSettings";
import type { NoteReference, SourceReference } from "../../api/schema";
import { RpcCallError, type NotientRpc } from "./rpc";

type ConventionSuggestion = Extract<
  MethodologySuggestionResult,
  { status: "convention-suggestion" }
>;

export interface ConventionDraft {
  text: string;
  evidence: SourceReference[];
  sources: NoteReference[];
  expectedCurrent: NoteReference[];
  methodologySnapshot: MethodologySettings;
  approvedPreview: { id: string; revision: string };
}

export class ConventionFreshnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConventionFreshnessError";
  }
}

function sameMethodology(left: MethodologySettings, right: MethodologySettings): boolean {
  return (
    left.mode === right.mode &&
    left.name === right.name &&
    left.conventions === right.conventions
  );
}

function sourceMatches(body: string, evidence: SourceReference): boolean {
  const { start, end, startLine, endLine } = evidence.range;
  if (end <= start || end > body.length || body.slice(start, end) !== evidence.quote) return false;
  const actualStartLine = body.slice(0, start).split(/\r\n|\n|\r/u).length;
  const actualEndLine = body.slice(0, end).split(/\r\n|\n|\r/u).length;
  return actualStartLine === startLine && actualEndLine === endLine;
}

function evidenceKey(evidence: SourceReference): string {
  return JSON.stringify([
    evidence.path,
    evidence.revision,
    evidence.range.start,
    evidence.range.end,
    evidence.range.startLine,
    evidence.range.endLine,
    evidence.quote,
  ]);
}

export async function prepareConventionDraft(
  rpc: NotientRpc,
  result: ConventionSuggestion,
  methodologySnapshot: MethodologySettings,
): Promise<ConventionDraft> {
  const { proposal } = await rpc.review(result.proposal.id);
  if (proposal.state !== "approved")
    throw new ConventionFreshnessError(
      "Approve this suggestion in review before using it as a configured convention.",
    );
  if (
    proposal.previewId !== result.previewId ||
    proposal.previewRevision !== result.previewRevision
  )
    throw new ConventionFreshnessError(
      "The approved suggestion no longer matches this study. Run a fresh methodology study.",
    );
  if (proposal.application && proposal.application.state !== "applied")
    throw new ConventionFreshnessError(
      "The approved suggestion did not finish applying. Inspect its review before using it.",
    );

  const [preview, currentSettings] = await Promise.all([
    rpc.changePreview(proposal.previewId),
    rpc.cultivationSettings(),
  ]);
  if (
    preview.previewId !== proposal.previewId ||
    preview.revision !== proposal.previewRevision ||
    preview.revision !== result.previewRevision
  )
    throw new ConventionFreshnessError(
      "The approved preview changed. Run a fresh methodology study before using this convention.",
    );
  if (!sameMethodology(currentSettings.methodology, methodologySnapshot))
    throw new ConventionFreshnessError(
      "Saved methodology settings changed since this study. Run it again before activating the suggestion.",
    );

  const changes = preview.changeSet.changes;
  if (
    changes.length !== 1 ||
    changes[0]?.kind !== "append" ||
    changes[0].source.path !== result.source.path ||
    changes[0].source.revision !== result.source.revision
  )
    throw new ConventionFreshnessError(
      "The approved preview is not the exact source-note append from this study.",
    );

  const effects = preview.effects.filter((effect) => effect.path === result.source.path);
  const effect = effects.length === 1 ? effects[0] : undefined;
  if (
    !effect ||
    effect.kind !== "write" ||
    effect.before === null ||
    effect.beforeRevision !== result.source.revision ||
    effect.afterRevision === effect.beforeRevision ||
    !effect.after.startsWith(effect.before)
  )
    throw new ConventionFreshnessError(
      "The approved preview does not contain one exact append to the studied note.",
    );

  const resultEvidenceKeys = new Set(result.evidence.map(evidenceKey));
  const proposalEvidenceKeys = new Set(proposal.provenance.evidence.map(evidenceKey));
  if (
    result.evidence.length !== proposal.provenance.evidence.length ||
    resultEvidenceKeys.size !== proposalEvidenceKeys.size ||
    [...resultEvidenceKeys].some((key) => !proposalEvidenceKeys.has(key))
  )
    throw new ConventionFreshnessError(
      "The review evidence differs from the methodology study. Run a fresh study.",
    );

  const originalSources = new Map<string, NoteReference>();
  const addOriginal = (source: NoteReference) => {
    const existing = originalSources.get(source.path);
    if (existing && existing.revision !== source.revision)
      throw new ConventionFreshnessError(
        `The study contains conflicting source revisions for ${source.path}. Run it again.`,
      );
    originalSources.set(source.path, source);
  };
  addOriginal(result.source);
  for (const source of result.examinedSources) addOriginal(source);
  for (const source of proposal.provenance.sources) addOriginal(source);
  for (const evidence of proposal.provenance.evidence)
    addOriginal({ path: evidence.path, revision: evidence.revision });

  const sourceNote = originalSources.get(result.source.path);
  if (!sourceNote || sourceNote.revision !== effect.beforeRevision)
    throw new ConventionFreshnessError(
      "The selected note revision differs from the approved append's before-state.",
    );

  for (const evidence of proposal.provenance.evidence) {
    if (evidence.path === result.source.path) {
      if (evidence.revision !== effect.beforeRevision || !sourceMatches(effect.before, evidence))
        throw new ConventionFreshnessError(
          `The approved append does not preserve the exact cited passage in ${evidence.path}.`,
        );
      continue;
    }
    const source = await rpc.noteBody(evidence.path, undefined, evidence.revision).catch((error) => {
      if (
        error instanceof RpcCallError &&
        (error.code === "CONFLICT" || error.code === "NOT_FOUND")
      )
        throw new ConventionFreshnessError(
          `Source ${evidence.path} changed since this study. Run a fresh methodology study before using its convention.`,
        );
      throw error;
    });
    if (!sourceMatches(source.body, evidence))
      throw new ConventionFreshnessError(
        `The cited passage changed in ${evidence.path}. Run a fresh methodology study.`,
      );
  }

  const expectedCurrent = new Map<string, NoteReference>();
  for (const source of originalSources.values()) {
    expectedCurrent.set(
      source.path,
      source.path === result.source.path
        ? { path: source.path, revision: effect.afterRevision }
        : source,
    );
  }
  const currentTarget = await rpc.noteBody(result.source.path);
  if (currentTarget.note.revision !== effect.afterRevision || currentTarget.body !== effect.after)
    throw new ConventionFreshnessError(
      "The studied note changed after its approved suggestion was applied. Run a fresh methodology study.",
    );

  const draft: ConventionDraft = {
    text: result.conventionSuggestion.text,
    evidence: proposal.provenance.evidence,
    sources: [...originalSources.values()],
    expectedCurrent: [...expectedCurrent.values()],
    methodologySnapshot: structuredClone(methodologySnapshot),
    approvedPreview: { id: preview.previewId, revision: preview.revision },
  };
  await validateConventionDraftCurrent(rpc, draft);
  return draft;
}

export async function validateConventionDraftCurrent(
  rpc: NotientRpc,
  draft: ConventionDraft,
): Promise<void> {
  const settings = await rpc.cultivationSettings();
  if (!sameMethodology(settings.methodology, draft.methodologySnapshot))
    throw new ConventionFreshnessError(
      "Saved methodology settings changed since this suggestion was prepared. Keep the draft for review, then run a fresh methodology study before saving it.",
    );
  for (const expected of draft.expectedCurrent) {
    try {
      await rpc.noteBody(expected.path, undefined, expected.revision);
    } catch (error) {
      if (
        error instanceof RpcCallError &&
        (error.code === "CONFLICT" || error.code === "NOT_FOUND")
      )
        throw new ConventionFreshnessError(
          `Source ${expected.path} changed since this suggestion was prepared. The draft remains visible, but a fresh methodology study is required before saving.`,
        );
      throw error;
    }
  }
}
