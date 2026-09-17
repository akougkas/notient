import { RecordId, type Surreal } from "surrealdb";
import type { VaultAdapter } from "../../adapters/vaultAdapter";
import {
  type ChangePreview,
  type ChangeResult,
  type PreviewEffect,
  changePreviewSchema,
} from "../../api/changes";
import { NoteReadService, contentRevision, inspectMarkdown, selectRange } from "../../api/notes";
import { operationInputs } from "../../api/operations";
import type { PipelineJob } from "../../api/pipelines";
import { NoteApiError } from "../../api/schema";
import type { NoteReference } from "../../api/schema";
import { type ApprovalService, renderApprovedRelation } from "../approvals/approvalService";
import { readReview } from "../approvals/reviewStorage";
import { WRITEBACK_EDGE_TABLES } from "../db/edgeTables";
import { parseSurrealRelationRecordId } from "../db/recordId";
import { patchFrontmatter } from "../markdown/frontmatter";
import { rewriteMovedReferences } from "../markdown/referenceMove";
import { JobStore } from "../pipelines/jobStore";
import { isCanonicalOrdinaryNotePath } from "../vault/publicPath";
import type { DurableNoteWriter } from "./durableNoteWriter";
import { EffectAuthorityRevoked, effectAuthorities, saveEffectAuthority } from "./effectAuthority";
import { bindMutationRequest } from "./mutationRequest";

export interface ChangeCaller {
  id: string;
  kind: "human" | "agent";
  scopes: string[];
}
export interface ChangeServiceOptions {
  db: Surreal;
  vault: VaultAdapter;
  writer: DurableNoteWriter;
  approvalService?: Pick<ApprovalService, "describeEdge" | "approveEdge">;
  authorizeCaller?: (caller: ChangeCaller) => void | Promise<void>;
  authorizeRecoveredJob?: (
    job: PipelineJob,
    preview: ChangePreview,
    effect: PreviewEffect,
  ) => void | Promise<void>;
  /** Background/caller policy and native-editor state, evaluated for each effect. */
  authorize?: (
    caller: ChangeCaller,
    preview: ChangePreview,
    effect: PreviewEffect,
  ) => Promise<void>;
}

/** Exact previews are durable inputs to the existing writer, not a second write engine. */
export class ChangeService {
  private readonly notes: NoteReadService;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: ChangeServiceOptions) {
    this.notes = new NoteReadService(options.vault);
  }

  async preview(input: unknown, caller: ChangeCaller): Promise<ChangePreview> {
    this.readAccess(caller);
    const parsed = operationInputs["changes.preview"].safeParse(input);
    if (!parsed.success) throw new NoteApiError("INVALID_PARAMS", parsed.error.message);
    const changeSet = parsed.data;
    const id = contentRevision(JSON.stringify([caller.id, changeSet.idempotencyKey]));
    const prior = await this.load(id);
    if (prior) {
      if (JSON.stringify(prior.changeSet) !== JSON.stringify(changeSet))
        throw new NoteApiError(
          "CONFLICT",
          "preview idempotency key was reused with different input",
        );
      return prior;
    }
    const effects: PreviewEffect[] = [];
    const conflicts: ChangePreview["conflicts"] = [];
    const touched = new Set<string>();
    const virtual = new Map<string, string>();
    const moved = new Set<string>();
    /** Move destinations in this change set, keyed to the moved saved source. */
    const movedTo = new Map<string, NoteReference>();
    let category: PreviewEffect["category"] = "body";
    const universe = (await this.options.vault.listMarkdown())
      .map((entry) => entry.path)
      .filter(isCanonicalOrdinaryNotePath);
    if (universe.length > 10000)
      throw new NoteApiError("LIMIT_EXCEEDED", "move reference scan exceeds 10,000 notes");
    const addWrite = (
      path: string,
      before: string | null,
      after: string,
      reason: string,
      relationship: PreviewEffect["relationship"] = null,
    ): void => {
      if (before === after && relationship === null) return;
      if (
        (moved.has(path) && !movedTo.has(path)) ||
        (virtual.has(path) && virtual.get(path) !== before)
      )
        throw new NoteApiError("CONFLICT", "change set contains incompatible overlapping edits");
      touched.add(path);
      virtual.set(path, after);
      effects.push({
        kind: "write",
        category,
        relationship,
        path,
        before,
        after,
        destination: null,
        beforeRevision: before === null ? null : contentRevision(before),
        afterRevision: contentRevision(after),
        reason,
      });
    };
    for (const change of changeSet.changes) {
      category =
        change.kind === "relationship"
          ? "relationships"
          : change.kind === "properties"
            ? "properties"
            : change.kind === "create"
              ? "create"
              : change.kind === "archive"
                ? "archive"
                : change.kind === "move" || change.kind === "unarchive"
                  ? "move"
                  : "body";
      if (change.kind === "create") {
        if (await this.options.vault.exists(change.path))
          throw new NoteApiError("CONFLICT", `destination exists: ${change.path}`);
        addWrite(change.path, null, change.body, "Create note");
        continue;
      }
      // A later change may edit a note this set moves. It names the moved
      // note's saved revision and edits the planned destination bytes.
      const origin = movedTo.get(change.source.path);
      if (origin && (change.source.revision !== origin.revision || change.kind === "relationship"))
        throw new NoteApiError(
          "CONFLICT",
          "edits to a moved note must name its saved source revision and cannot add relationships",
        );
      const note = await this.notes.read(origin ?? change.source);
      if (origin) note.note.path = change.source.path;
      const preceding = virtual.get(change.source.path);
      if (preceding !== undefined) {
        if (change.kind === "edit" && change.selector.kind === "range" && preceding !== note.body)
          throw new NoteApiError(
            "CONFLICT",
            "byte-range edits cannot follow another edit to the same source revision",
          );
        note.body = preceding;
        note.note.revision = contentRevision(preceding);
        note.structure = inspectMarkdown(preceding);
      }
      if (change.kind === "relationship") {
        const authority = this.options.approvalService;
        if (!authority) throw new Error("relationship authority is unavailable");
        const edge = parseSurrealRelationRecordId(change.edgeId, WRITEBACK_EDGE_TABLES);
        const description = await authority.describeEdge({ id: edge.recordId, table: edge.table });
        const target = await this.notes.read(change.target);
        if (description.fromPath !== change.source.path || description.toPath !== target.note.path)
          throw new NoteApiError(
            "CONFLICT",
            "relationship endpoints do not match reviewed sources",
          );
        addWrite(
          note.note.path,
          note.body,
          renderApprovedRelation(note.body, edge.table, target.note.path),
          "Apply reviewed relationship",
          { edgeId: edge.id, table: edge.table, target: target.note },
        );
      } else if (change.kind === "append")
        addWrite(change.source.path, note.body, note.body + change.text, "Append text");
      else if (change.kind === "properties")
        addWrite(
          change.source.path,
          note.body,
          patchFrontmatter(note.body, change.patch),
          "Update selected properties",
        );
      else if (change.kind === "edit") {
        const range = selectRange(note.body, note.structure, change.selector);
        addWrite(
          change.source.path,
          note.body,
          note.body.slice(0, range.start) + change.replacement + note.body.slice(range.end),
          "Replace selected content",
        );
      } else {
        if (
          moved.has(change.source.path) ||
          touched.has(change.destination) ||
          (await this.options.vault.exists(change.destination))
        )
          throw new NoteApiError("CONFLICT", "move destination exists or overlaps another effect");
        // Rewrite inbound references first. Partial application remains explicit;
        // a retry resumes by each effect's stable history receipt.
        if (change.updateReferences) {
          for (const path of universe) {
            if (path === change.source.path) continue;
            const referring = await this.notes.read({ path });
            referring.body = virtual.get(path) ?? referring.body;
            const rewritten = rewriteMovedReferences(
              referring.body,
              path,
              change.source.path,
              change.destination,
              universe,
            );
            for (const reason of rewritten.ambiguous) conflicts.push({ path, reason });
            if (rewritten.count)
              addWrite(
                path,
                referring.body,
                rewritten.body,
                `Update references to ${change.destination}`,
              );
          }
        }
        touched.add(change.source.path);
        touched.add(change.destination);
        moved.add(change.source.path);
        moved.add(change.destination);
        effects.push({
          kind: "move",
          category,
          relationship: null,
          path: change.source.path,
          destination: change.destination,
          before: note.body,
          after: note.body,
          beforeRevision: note.note.revision,
          afterRevision: note.note.revision,
          reason: change.kind,
        });
        const outgoing = rewriteMovedReferences(
          note.body,
          change.source.path,
          change.source.path,
          change.destination,
          universe,
          change.destination,
        );
        for (const reason of outgoing.ambiguous)
          conflicts.push({ path: change.source.path, reason });
        if (outgoing.count)
          effects.push({
            kind: "write",
            category,
            relationship: null,
            path: change.destination,
            destination: null,
            before: note.body,
            after: outgoing.body,
            beforeRevision: note.note.revision,
            afterRevision: contentRevision(outgoing.body),
            reason: "Rebase moved note links",
          });
        virtual.set(change.destination, outgoing.count ? outgoing.body : note.body);
        movedTo.set(change.destination, change.source);
      }
    }
    if (effects.length > 200 || JSON.stringify(effects).length > 16 * 1024 * 1024)
      throw new NoteApiError("LIMIT_EXCEEDED", "preview exceeds 200 effects or 16 MiB");
    const preview: ChangePreview = {
      ok: true,
      previewId: id,
      revision: contentRevision(JSON.stringify([changeSet, effects, conflicts])),
      owner: caller.id,
      changeSet,
      effects,
      conflicts,
      createdAt: Date.now(),
    };
    const recordId = new RecordId("change_preview", id);
    await this.options.db
      .query("CREATE ONLY $id CONTENT { owner: $owner, payload: $payload } RETURN NONE;", {
        id: recordId,
        owner: caller.id,
        payload: JSON.stringify(preview),
      })
      .collect();
    return preview;
  }

  async get(id: string, caller: ChangeCaller): Promise<ChangePreview> {
    this.readAccess(caller);
    const preview = await this.load(id);
    if (!preview) throw new NoteApiError("NOT_FOUND", "preview does not exist");
    if (caller.kind !== "human" && caller.id !== preview.owner)
      throw new NoteApiError("FORBIDDEN", "preview belongs to another caller");
    return preview;
  }

  /** Verify original evidence sources or exact intermediate bytes in this
   * reviewed change chain; unrelated source edits always invalidate it. */
  async validateSources(preview: ChangePreview, sources: NoteReference[]): Promise<void> {
    for (const source of sources) {
      let current: string | null = null;
      try {
        current = (await this.notes.read({ path: source.path })).note.revision;
      } catch (error) {
        if (!(error instanceof NoteApiError) || error.code !== "NOT_FOUND") throw error;
      }
      if (current === source.revision) continue;
      const effects = preview.effects.filter((effect) => effect.path === source.path);
      if (
        current !== null &&
        effects.some(
          (effect) => effect.beforeRevision === current || effect.afterRevision === current,
        )
      )
        continue;
      const move = effects.find((effect) => effect.kind === "move");
      if (current === null && move?.destination) {
        const destination = await this.notes.read({ path: move.destination });
        if (destination.note.revision === move.afterRevision) continue;
      }
      throw new NoteApiError("CONFLICT", `evidence source changed: ${source.path}`);
    }
  }

  apply(
    input: unknown,
    caller: ChangeCaller,
    signal: AbortSignal,
    authority?: (preview: ChangePreview, effect: PreviewEffect) => Promise<void>,
    reviewId?: string,
  ): Promise<ChangeResult> {
    const operation = this.tail
      .catch(() => {})
      .then(() => this.applySerial(input, caller, signal, authority, reviewId));
    this.tail = operation;
    return operation;
  }

  private async applySerial(
    input: unknown,
    caller: ChangeCaller,
    signal: AbortSignal,
    authority?: (preview: ChangePreview, effect: PreviewEffect) => Promise<void>,
    reviewId?: string,
  ): Promise<ChangeResult> {
    const parsed = operationInputs["changes.apply"].safeParse(input);
    if (!parsed.success) throw new NoteApiError("INVALID_PARAMS", parsed.error.message);
    const request = parsed.data;
    const preview = await this.get(request.previewId, caller);
    if (request.previewRevision !== preview.revision)
      throw new NoteApiError("CONFLICT", "preview revision changed");
    if (preview.conflicts.length)
      throw new NoteApiError("CONFLICT", "resolve the reference ambiguities before applying");
    if (!caller.scopes.includes("write"))
      throw new NoteApiError("FORBIDDEN", "change requires write scope");
    await bindMutationRequest(this.options.db, "changes", caller, request.idempotencyKey, {
      ...request,
      reviewId: reviewId ?? null,
    });
    const reviewAccess = async () => {
      const [rows] = await this.options.db
        .query<[Array<{ id: unknown; state: string }>]>(
          "SELECT id, state FROM proposal_review WHERE preview_id = $preview;",
          { preview: preview.previewId },
        )
        .collect();
      for (const row of rows) {
        if (row.state === "rejected")
          throw new NoteApiError("FORBIDDEN", "this proposal was rejected");
        if (String(row.id) !== String(new RecordId("proposal_review", reviewId ?? "unreviewed")))
          throw new NoteApiError(
            "PENDING_APPROVAL",
            "apply this stored proposal through proposals.approve",
          );
      }
    };
    await reviewAccess();
    const result: ChangeResult = {
      ok: true,
      previewId: preview.previewId,
      state: "applied",
      effects: [],
    };
    for (const [index, effect] of preview.effects.entries()) {
      try {
        signal.throwIfAborted();
        const authorize = async (): Promise<void> => {
          signal.throwIfAborted();
          if (caller.kind === "human") await this.options.authorizeCaller?.(caller);
          if (!caller.scopes.includes("write"))
            throw new NoteApiError("FORBIDDEN", "change requires write scope");
          if (caller.kind !== "human" && !this.options.authorize && !authority)
            throw new NoteApiError(
              "PENDING_APPROVAL",
              "agent changes require the exact human preview approval or an explicit scoped policy",
            );
          await this.options.authorize?.(caller, preview, effect);
          await reviewAccess();
          await authority?.(preview, effect);
          if (effect.relationship) await this.notes.read(effect.relationship.target);
        };
        await authorize();
        const review = reviewId ? await readReview(this.options.db, reviewId) : null;
        await saveEffectAuthority(
          this.options.db,
          {
            previewId: preview.previewId,
            previewRevision: preview.revision,
            index,
            caller,
            reviewId: reviewId ?? null,
            jobId:
              caller.kind === "agent" && review && "jobId" in review.provenance
                ? review.provenance.jobId
                : null,
          },
          effect,
        );
        const receipt = effect.relationship
          ? await this.applyRelationship(effect, caller, authorize)
          : await this.options.writer.apply({
              kind:
                effect.kind === "move"
                  ? "notes.move"
                  : effect.before === null
                    ? "notes.create"
                    : "notes.replace_section",
              target: effect.path,
              ...(effect.destination === null ? {} : { destination: effect.destination }),
              before: effect.before,
              after: effect.after,
              clientIdentity: preview.owner,
              idempotencyKey: `change:${preview.previewId}:${index}`,
              previewId: preview.previewId,
              authorize,
            });
        if (!receipt.applied)
          throw new NoteApiError("CONFLICT", "source or destination changed after preview");
        result.effects.push({
          index,
          path: effect.path,
          state: "applied",
          historyId: receipt.historyId,
          message: null,
        });
      } catch (error) {
        const state = signal.aborted
          ? "cancelled"
          : error instanceof NoteApiError && ["FORBIDDEN", "PENDING_APPROVAL"].includes(error.code)
            ? "denied"
            : "conflict";
        result.effects.push({
          index,
          path: effect.path,
          state,
          historyId: null,
          message: error instanceof Error ? error.message : String(error),
        });
        result.ok = false;
        result.state = result.effects.some((item) => item.state === "applied") ? "partial" : state;
        break;
      }
    }
    return result;
  }

  async authorizeRecoveredEffect(
    selector: { previewId: string } | { edgeId: string },
    transition: { target: string; destination?: string; before: string | null; after: string },
  ): Promise<void> {
    try {
      const candidates = await effectAuthorities(this.options.db, selector);
      for (const authority of candidates) {
        const preview = await this.load(authority.previewId);
        const effect = preview?.effects[authority.index];
        if (!preview || preview.revision !== authority.previewRevision || !effect)
          throw new EffectAuthorityRevoked("stored effect authority no longer matches its preview");
        if (
          effect.path !== transition.target ||
          effect.before !== transition.before ||
          effect.after !== transition.after ||
          (effect.destination ?? undefined) !== transition.destination
        )
          continue;
        if (!authority.caller.scopes.includes("write"))
          throw new EffectAuthorityRevoked("effect has no write authority");
        if (authority.caller.id.startsWith("paired-") && !this.options.authorizeCaller)
          throw new EffectAuthorityRevoked("paired caller validation is unavailable");
        // Pipeline caller identity is recovered from the durable job below;
        // the execution principal deliberately had no human approval power.
        if (authority.caller.kind === "human")
          await this.options.authorizeCaller?.(authority.caller);
        if (authority.reviewId) {
          const review = await readReview(this.options.db, authority.reviewId);
          if (
            !review ||
            review.state === "rejected" ||
            review.previewId !== preview.previewId ||
            review.previewRevision !== preview.revision
          )
            throw new EffectAuthorityRevoked(
              "review was removed, rejected or replaced before recovery",
            );
          await this.validateSources(preview, review.provenance.sources);
        }
        if (authority.caller.kind === "agent") {
          if (!authority.jobId || !this.options.authorizeRecoveredJob)
            throw new EffectAuthorityRevoked(
              "interrupted agent effect needs a current scoped workflow authority",
            );
          const job = await new JobStore(this.options.db).get(authority.jobId);
          if (
            !job ||
            job.caller.id !== authority.caller.id ||
            job.previewId !== preview.previewId ||
            !["running", "queued"].includes(job.state)
          )
            throw new EffectAuthorityRevoked(
              "the workflow no longer authorizes this interrupted effect",
            );
          await this.options.authorizeCaller?.(job.caller);
          await this.options.authorizeRecoveredJob(job, preview, effect);
        }
        if (effect.relationship) await this.notes.read(effect.relationship.target);
        return;
      }
      throw new EffectAuthorityRevoked(
        "interrupted effect has no matching durable caller authority",
      );
    } catch (error) {
      if (error instanceof NoteApiError) throw new EffectAuthorityRevoked(error.message);
      throw error;
    }
  }

  private async applyRelationship(
    effect: PreviewEffect,
    caller: ChangeCaller,
    authorize: () => Promise<void>,
  ) {
    if (!effect.relationship || !this.options.approvalService || effect.before === null)
      throw new Error("relationship effect is missing its approval authority");
    const edge = parseSurrealRelationRecordId(effect.relationship.edgeId, WRITEBACK_EDGE_TABLES);
    const receipt = await this.options.approvalService.approveEdge(
      { id: edge.recordId, table: edge.table, approvedBy: caller.id },
      { before: effect.before, after: effect.after, authorize },
    );
    return receipt
      ? { applied: true as const, historyId: receipt.historyId }
      : { applied: false as const };
  }

  private async load(id: string): Promise<ChangePreview | null> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new NoteApiError("INVALID_PARAMS", "invalid preview id");
    const [rows] = await this.options.db
      .query<[Array<{ payload: string }>]>("SELECT payload FROM change_preview WHERE id = $id;", {
        id: new RecordId("change_preview", id),
      })
      .collect();
    return rows.length ? changePreviewSchema.parse(JSON.parse(rows[0].payload)) : null;
  }
  private readAccess(caller: ChangeCaller): void {
    if (!caller.scopes.includes("read"))
      throw new NoteApiError("FORBIDDEN", "change preview requires read scope");
  }
}
