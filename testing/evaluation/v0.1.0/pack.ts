/**
 * Notient v0.1.0 evaluation pack.
 *
 * The vault is `testing/fixtures/v0.1.0` plus the notes below. Expected source
 * evidence was fixed here before any prompt tuning. The deterministic runner
 * (`testing/integration/evaluation`) replays each case's scripted structured
 * output through a real daemon; the real-model probe (`tools/evaluate-pack.ts`)
 * sends the same sources to a configured model and records observations. A
 * scripted pass proves pipeline integrity, never model quality.
 */
import type { PipelineId } from "../../../src/api/operations";

export const EVALUATION_NOTES: Record<string, string> = {
  "Projects/Replication.md":
    "# Replication\n\nQuorum writes wait for acknowledgements from two of the three replicas before a commit is reported.\nA lagging replica catches up from the write-ahead log.\n",
  "Projects/Cache plan.md":
    "# Cache plan\n\nThe read cache is invalidated by content revision, never by wall-clock expiry.\nCache entries are keyed by note path and content revision.\n",
  "Projects/Old cache plan.md":
    "# Old cache plan\n\nSuperseded by [[Projects/Cache plan]]. The read cache expires entries after ten minutes.\n",
  "Projects/Done migration.md":
    "# Storage migration\n\nThe migration finished on 2026-05-02. Every task below is complete and nothing remains open.\n\n- [x] Copy notes to the new volume\n- [x] Verify checksums\n",
  "Projects/Active work.md":
    "# Rebuild timing\n\nIndex rebuild timing is still being measured.\n\n- [ ] Measure rebuild time on the large vault\n",
  "Reference/Evergreen.md":
    "---\ntags: [keep]\n---\n# Durability glossary\n\nDurability means a committed write survives a crash.\n",
  "Inbox/Raft.md":
    "# Raft\n\nRaft elects one leader per term through randomized election timeouts.\n",
  "Inbox/Lease.md":
    "# Leases\n\nA leader lease lets a Raft leader serve reads without a quorum round while its clock bound holds.\n",
  "Inbox/Fragment.md": "call back about the thing?\n",
  "Inbox/Scaffold.md": "# Notes\n\nTODO: fill this in later.\n",
  "Projects/Guarantee.md":
    "# Production durability guarantee\n\nFor the 2026-09-16 production cluster, every acknowledged write survives the loss of any one replica, even if replication was not complete.\n",
  "Projects/Loss.md":
    "# Production durability failure\n\nFor the same 2026-09-16 production cluster, an acknowledged write can be lost when one replica fails before replication completes. This describes the same current configuration as [[Projects/Guarantee]].\n",
  "Inbox/Done.md": "---\nstatus: processed\n---\n# Old capture\n\nAlready handled.\n",
};

/** Notes whose modification time is set beyond the archive age criterion. */
export const AGED_NOTES = [
  "Projects/Old cache plan.md",
  "Projects/Done migration.md",
  "Projects/Active work.md",
  "Reference/Evergreen.md",
  "History/Storage.md",
];

export const QUOTES = {
  quorum:
    "Quorum writes wait for acknowledgements from two of the three replicas before a commit is reported.",
  catchUp: "A lagging replica catches up from the write-ahead log.",
  threeReplicas: "The 2026 storage service keeps three replicas.",
  oneReplica: "As of 2026-09-01 the production storage service keeps exactly one replica.",
  sameService: "This assertion applies to the same production service as [[Projects/Storage]].",
  prototype:
    "The 2024 prototype used one replica; this is historical, not a claim about production in 2026.",
  raft: "Raft elects one leader per term through randomized election timeouts.",
  lease:
    "A leader lease lets a Raft leader serve reads without a quorum round while its clock bound holds.",
  cacheRevision: "The read cache is invalidated by content revision, never by wall-clock expiry.",
  cacheExpiry: "The read cache expires entries after ten minutes.",
  superseded: "Superseded by [[Projects/Cache plan]].",
  migrationDone:
    "The migration finished on 2026-05-02. Every task below is complete and nothing remains open.",
  policyReplica: "exactly one replica",
  basil: "Plant basil after the last frost.",
  fragment: "call back about the thing?",
  replicaQuestion: "What is the production replica count?",
  survives:
    "every acknowledged write survives the loss of any one replica, even if replication was not complete.",
  lost: "an acknowledged write can be lost when one replica fails before replication completes.",
} as const;

export interface SuppliedDocument {
  index: number;
  path: string;
}

export type CaseKind =
  | "positive"
  | "abstain"
  | "provider-failure"
  | "interruption"
  | "stale-source"
  | "permission-change";

export interface EvaluationCase {
  id: string;
  pipeline: PipelineId;
  kind: CaseKind;
  sources: string[];
  /** What a useful result is, for a person judging a real-model observation. */
  usefulness: string;
  /**
   * The case checks a deterministic filter over a scripted answer. A real model
   * is free to answer differently, so the real-model probe skips it.
   */
  scriptedOnly?: boolean;
  /** Scripted structured output per stage schema name (deterministic runner only). */
  script: (stage: string, at: (path: string) => number) => unknown;
  expect: {
    /** Exact passages a correct result must cite, fixed before tuning. */
    evidence?: Array<{ path: string; quote: string }>;
    /** Kinds of planned note changes, in order. Empty means no change. */
    changes?: string[];
    relationships?: Array<{ relation: string; source: string; target: string }>;
    findingKinds?: string[];
    abstained?: boolean;
    /**
     * Notes that must appear in no finding or relationship. Relate, contradiction
     * and synthesis runs also inspect retrieved neighbours, so a real model may
     * correctly connect other notes; only a link to these would be noise.
     */
    unrelatedPaths?: string[];
    /** Stages that must not be reached, e.g. a deterministic pre-model refusal. */
    modelCalls?: number;
  };
}

const none = { comparisons: [], abstention: "No useful connection." };
const noEnrichment = { suggestions: [], abstention: "Nothing to add." };
const extraction = (
  claims: Array<{ text: string; kind: string }>,
  entities: Array<{ label: string; kind: string }> = [],
  questions: string[] = [],
) => ({
  entities: entities.map((entity) => ({ ...entity, chunkRefs: [0] })),
  claims: claims.map((claim) => ({ ...claim, chunkRefs: [0] })),
  questions: questions.map((text) => ({ text, chunkRefs: [0] })),
});

/** The failure and staleness cases reuse a positive script: the fault is injected by the runner. */
function faulted(
  base: EvaluationCase,
  kind: Exclude<CaseKind, "positive" | "abstain">,
): EvaluationCase {
  return {
    ...base,
    id: `${base.pipeline}/${kind}`,
    kind,
    usefulness:
      kind === "stale-source"
        ? "A source edited during inference must leave no proposal built on the old bytes."
        : kind === "permission-change"
          ? "Revoking the caller during inference cancels the run with no proposal or effect."
          : kind === "interruption"
            ? "A cancelled run keeps its charged usage and produces no proposal or effect."
            : "A provider outage is recorded, retried within budget and never becomes an empty success.",
    expect: { changes: [], relationships: [] },
  };
}

const indexPositive: EvaluationCase = {
  id: "index-extract/positive-claim",
  pipeline: "index-extract",
  kind: "positive",
  sources: ["Projects/Replication.md"],
  usefulness: "Extracts the quorum rule as a claim a reader could dispute, with its passage.",
  script: () =>
    extraction(
      [{ text: "Quorum writes need two of three replica acknowledgements.", kind: "assertion" }],
      [{ label: "write-ahead log", kind: "technique" }],
    ),
  expect: {
    evidence: [{ path: "Projects/Replication.md", quote: QUOTES.quorum }],
    findingKinds: ["concept", "claim"],
    changes: [],
  },
};

const enrichPositive: EvaluationCase = {
  id: "enrich/positive-new-metadata",
  pipeline: "enrich",
  kind: "positive",
  sources: ["Projects/Replication.md"],
  usefulness: "Retrieval-useful tags and a factual summary; no invented replication facts.",
  script: (_stage, at) => ({
    suggestions: [
      {
        note: at("Projects/Replication.md"),
        summary: "Commits are reported after two of three replicas acknowledge a write.",
        tags: ["replication", "quorum"],
        aliases: ["Quorum writes"],
        reason: "The note defines the quorum rule for replicated writes.",
        evidence: [{ note: at("Projects/Replication.md"), quote: QUOTES.quorum }],
      },
    ],
    abstention: null,
  }),
  expect: {
    evidence: [{ path: "Projects/Replication.md", quote: QUOTES.quorum }],
    changes: ["properties", "append"],
    findingKinds: ["metadata", "summary"],
  },
};

const relatePositive: EvaluationCase = {
  id: "relate/positive-extends",
  pipeline: "relate",
  kind: "positive",
  sources: ["Projects/Replication.md", "Projects/Storage.md"],
  usefulness:
    "Explains that the quorum rule develops the three-replica design, directed Replication -> Storage.",
  script: (_stage, at) => ({
    comparisons: [
      {
        source: at("Projects/Replication.md"),
        target: at("Projects/Storage.md"),
        judgment: "extends",
        assessment: 0.8,
        explanation:
          "Replication adds the commit rule for the three replicas that Storage establishes.",
        evidence: [
          { note: at("Projects/Replication.md"), quote: QUOTES.quorum },
          { note: at("Projects/Storage.md"), quote: QUOTES.threeReplicas },
        ],
      },
    ],
    abstention: null,
  }),
  expect: {
    evidence: [
      { path: "Projects/Replication.md", quote: QUOTES.quorum },
      { path: "Projects/Storage.md", quote: QUOTES.threeReplicas },
    ],
    relationships: [
      { relation: "extends", source: "Projects/Replication.md", target: "Projects/Storage.md" },
    ],
    changes: [],
  },
};

const contradictionPositive: EvaluationCase = {
  id: "contradictions/positive-genuine",
  pipeline: "contradictions",
  kind: "positive",
  sources: ["Projects/Guarantee.md", "Projects/Loss.md"],
  usefulness:
    "Both notes describe the same cluster on the same date; surviving any replica loss against losing acknowledged writes is a genuine conflict.",
  script: (_stage, at) => ({
    comparisons: [
      {
        source: at("Projects/Guarantee.md"),
        target: at("Projects/Loss.md"),
        judgment: "contradiction",
        assessment: 0.9,
        explanation:
          "Production durability guarantee says acknowledged writes survive one replica loss, while Production durability failure says they can be lost in the same configuration.",
        evidence: [
          { note: at("Projects/Guarantee.md"), quote: QUOTES.survives },
          { note: at("Projects/Loss.md"), quote: QUOTES.lost },
        ],
      },
    ],
    abstention: null,
  }),
  expect: {
    evidence: [
      { path: "Projects/Guarantee.md", quote: QUOTES.survives },
      { path: "Projects/Loss.md", quote: QUOTES.lost },
    ],
    findingKinds: ["contradiction"],
    relationships: [
      { relation: "contradicts", source: "Projects/Guarantee.md", target: "Projects/Loss.md" },
    ],
    changes: [],
  },
};

const synthesisScript =
  (
    title: string,
    left: { path: string; quote: string },
    right: { path: string; quote: string },
    text: string,
  ): EvaluationCase["script"] =>
  (_stage, at) => ({
    title,
    sections: [
      {
        heading: "How the notes connect",
        paragraphs: [
          {
            text,
            evidence: [
              { note: at(left.path), quote: left.quote },
              { note: at(right.path), quote: right.quote },
            ],
          },
        ],
      },
    ],
    abstention: null,
  });

const synthesisPositive: EvaluationCase = {
  id: "synthesize/positive-storage",
  pipeline: "synthesize",
  kind: "positive",
  sources: ["Projects/Replication.md", "Projects/Storage.md"],
  usefulness:
    "Original prose that connects the replica count to the quorum rule, cited to both notes.",
  script: synthesisScript(
    "Replicated storage commits",
    { path: "Projects/Replication.md", quote: QUOTES.quorum },
    { path: "Projects/Storage.md", quote: QUOTES.threeReplicas },
    "The storage service runs three replicas, and a write is reported committed once two of them acknowledge it, so one replica may lag without blocking commits.",
  ),
  expect: {
    evidence: [
      { path: "Projects/Replication.md", quote: QUOTES.quorum },
      { path: "Projects/Storage.md", quote: QUOTES.threeReplicas },
    ],
    changes: ["create"],
    findingKinds: ["synthesis"],
  },
};

const inboxScript =
  (path: string, quote: string, title: string, tags: string[]): EvaluationCase["script"] =>
  (stage, at) => {
    if (stage === "classify_inbox")
      return {
        items: [
          {
            note: at(path),
            category: "reference",
            decision: "organize",
            title,
            explanation: "A self-contained explanation with a clear subject.",
            evidence: [{ note: at(path), quote }],
          },
        ],
        abstention: null,
      };
    if (stage === "enrich_notes")
      return tags.length
        ? {
            suggestions: [
              {
                note: at(path),
                summary: "",
                tags,
                aliases: [],
                reason: "Names the consensus topic for retrieval.",
                evidence: [{ note: at(path), quote }],
              },
            ],
            abstention: null,
          }
        : noEnrichment;
    return none;
  };

const inboxPositive: EvaluationCase = {
  id: "inbox/positive-organize",
  pipeline: "inbox",
  kind: "positive",
  sources: ["Inbox/Raft.md"],
  usefulness: "Routes a substantive capture out of the inbox under a usable title.",
  script: inboxScript("Inbox/Raft.md", QUOTES.raft, "Raft leader election", []),
  expect: {
    evidence: [{ path: "Inbox/Raft.md", quote: QUOTES.raft }],
    changes: ["move", "properties"],
    findingKinds: ["inbox"],
  },
};

const archivePositive: EvaluationCase = {
  id: "archive/positive-completed",
  pipeline: "archive",
  kind: "positive",
  sources: ["Projects/Done migration.md"],
  usefulness:
    "Archives only because the note itself says the work is finished, not because it is old.",
  script: (_stage, at) => ({
    reviews: [
      {
        note: at("Projects/Done migration.md"),
        judgment: "completed",
        explanation: "The note states the migration finished with every task complete.",
        evidence: [{ note: at("Projects/Done migration.md"), quote: QUOTES.migrationDone }],
      },
    ],
    abstention: null,
  }),
  expect: {
    evidence: [{ path: "Projects/Done migration.md", quote: QUOTES.migrationDone }],
    changes: ["archive"],
    findingKinds: ["archive"],
  },
};

export const EVALUATION_CASES: EvaluationCase[] = [
  // index-extract
  indexPositive,
  {
    id: "index-extract/positive-dated-policy",
    pipeline: "index-extract",
    kind: "positive",
    sources: ["History/Storage.md"],
    usefulness: "Keeps the date and the exact replica count in the extracted claim.",
    script: () =>
      extraction([
        { text: "As of 2026-09-01 production storage keeps exactly one replica.", kind: "datum" },
      ]),
    expect: {
      evidence: [{ path: "History/Storage.md", quote: QUOTES.policyReplica }],
      findingKinds: ["claim"],
      changes: [],
    },
  },
  {
    id: "index-extract/abstain-fragment",
    pipeline: "index-extract",
    kind: "abstain",
    sources: ["Inbox/Fragment.md"],
    usefulness: "A raw fragment yields no concept, claim or question.",
    script: () => extraction([]),
    expect: { abstained: true, changes: [] },
  },
  {
    id: "index-extract/abstain-scaffold",
    pipeline: "index-extract",
    kind: "abstain",
    sources: ["Inbox/Scaffold.md"],
    usefulness: "A placeholder asserts nothing; an extracted claim here would be invented.",
    script: () => extraction([]),
    expect: { abstained: true, changes: [] },
  },
  faulted(indexPositive, "provider-failure"),
  faulted(indexPositive, "stale-source"),

  // enrich
  enrichPositive,
  {
    id: "enrich/positive-extends-authored",
    pipeline: "enrich",
    kind: "positive",
    sources: ["Projects/Storage.md"],
    usefulness: "Adds only new values after the authored ones; inline #durability is not copied.",
    script: (_stage, at) => ({
      suggestions: [
        {
          note: at("Projects/Storage.md"),
          summary: "",
          tags: ["durability", "Systems", "replication"],
          aliases: ["storage PLAN", "Storage service"],
          reason: "The note is the storage service design record.",
          evidence: [{ note: at("Projects/Storage.md"), quote: QUOTES.threeReplicas }],
        },
      ],
      abstention: null,
    }),
    expect: {
      evidence: [{ path: "Projects/Storage.md", quote: QUOTES.threeReplicas }],
      changes: ["properties"],
      findingKinds: ["metadata"],
    },
  },
  {
    id: "enrich/abstain-fragment",
    pipeline: "enrich",
    kind: "abstain",
    sources: ["Inbox/Fragment.md"],
    usefulness: "No topic to describe; inventing tags for a fragment is noise.",
    script: () => noEnrichment,
    expect: { abstained: true, changes: [] },
  },
  {
    id: "enrich/abstain-already-represented",
    pipeline: "enrich",
    kind: "abstain",
    scriptedOnly: true,
    sources: ["Projects/Storage.md"],
    usefulness: "Case and inline variants of existing metadata must not produce a change.",
    script: (_stage, at) => ({
      suggestions: [
        {
          note: at("Projects/Storage.md"),
          summary: "",
          tags: ["SYSTEMS", "Durability"],
          aliases: ["storage plan"],
          reason: "Repeats existing metadata.",
          evidence: [{ note: at("Projects/Storage.md"), quote: QUOTES.threeReplicas }],
        },
      ],
      abstention: null,
    }),
    // The summary section is disabled for this case by the empty summary.
    expect: { abstained: true, changes: [] },
  },
  faulted(enrichPositive, "provider-failure"),
  faulted(enrichPositive, "permission-change"),

  // relate
  relatePositive,
  {
    id: "relate/positive-lease-extends-raft",
    pipeline: "relate",
    kind: "positive",
    sources: ["Inbox/Lease.md", "Inbox/Raft.md"],
    usefulness: "Leases develop Raft leadership with a read optimisation; direction Lease -> Raft.",
    script: (_stage, at) => ({
      comparisons: [
        {
          source: at("Inbox/Lease.md"),
          target: at("Inbox/Raft.md"),
          judgment: "extends",
          assessment: 0.7,
          explanation: "Leases add a read path to the single elected leader that Raft provides.",
          evidence: [
            { note: at("Inbox/Lease.md"), quote: QUOTES.lease },
            { note: at("Inbox/Raft.md"), quote: QUOTES.raft },
          ],
        },
      ],
      abstention: null,
    }),
    expect: {
      evidence: [
        { path: "Inbox/Lease.md", quote: QUOTES.lease },
        { path: "Inbox/Raft.md", quote: QUOTES.raft },
      ],
      relationships: [{ relation: "extends", source: "Inbox/Lease.md", target: "Inbox/Raft.md" }],
      changes: [],
    },
  },
  {
    id: "relate/abstain-unrelated",
    pipeline: "relate",
    kind: "abstain",
    sources: ["Garden.md", "Projects/Storage.md"],
    usefulness: "Gardening and storage design share nothing; any proposed link is noise.",
    script: (_stage, at) => ({
      comparisons: [
        {
          source: at("Garden.md"),
          target: at("Projects/Storage.md"),
          judgment: "unrelated",
          assessment: 0,
          explanation: "Garden covers plant care and Storage covers replication.",
          evidence: [],
        },
      ],
      abstention: null,
    }),
    expect: { abstained: true, relationships: [], changes: [], unrelatedPaths: ["Garden.md"] },
  },
  {
    id: "relate/abstain-question-is-not-a-claim",
    pipeline: "relate",
    kind: "abstain",
    sources: ["Questions.md", "Projects/Storage.md"],
    usefulness: "An open question about the replica count does not support or extend the design.",
    script: (_stage, at) => ({
      comparisons: [
        {
          source: at("Questions.md"),
          target: at("Projects/Storage.md"),
          judgment: "insufficient",
          assessment: 0.2,
          explanation: "Questions only asks for the replica count and asserts nothing.",
          evidence: [{ note: at("Questions.md"), quote: QUOTES.replicaQuestion }],
        },
      ],
      abstention: null,
    }),
    expect: { abstained: true, relationships: [], changes: [], unrelatedPaths: ["Questions.md"] },
  },
  faulted(relatePositive, "provider-failure"),
  faulted(relatePositive, "stale-source"),

  // contradictions
  contradictionPositive,
  {
    id: "contradictions/positive-apparent-temporal",
    pipeline: "contradictions",
    kind: "positive",
    sources: ["Projects/Storage.md", "Archive/Old plan.md"],
    usefulness:
      "The 2024 prototype note disclaims 2026 production; report a change over time, never a contradiction edge.",
    script: (_stage, at) => ({
      comparisons: [
        {
          source: at("Archive/Old plan.md"),
          target: at("Projects/Storage.md"),
          judgment: "temporal-change",
          assessment: 0.7,
          explanation:
            "Superseded plan describes the 2024 prototype and says it makes no claim about 2026, when Storage reports three replicas.",
          evidence: [
            { note: at("Archive/Old plan.md"), quote: QUOTES.prototype },
            { note: at("Projects/Storage.md"), quote: QUOTES.threeReplicas },
          ],
        },
      ],
      abstention: null,
    }),
    expect: {
      evidence: [
        { path: "Archive/Old plan.md", quote: QUOTES.prototype },
        { path: "Projects/Storage.md", quote: QUOTES.threeReplicas },
      ],
      findingKinds: ["temporal-change"],
      relationships: [],
      changes: [],
    },
  },
  {
    id: "contradictions/abstain-unrelated",
    pipeline: "contradictions",
    kind: "abstain",
    sources: ["Garden.md", "Projects/Storage.md"],
    usefulness: "No shared referent, so no conflict can exist.",
    script: () => ({ comparisons: [], abstention: "The notes discuss different subjects." }),
    expect: { abstained: true, relationships: [], changes: [], unrelatedPaths: ["Garden.md"] },
  },
  {
    id: "contradictions/abstain-agreement-filtered",
    pipeline: "contradictions",
    kind: "abstain",
    scriptedOnly: true,
    sources: ["Projects/Replication.md", "Projects/Storage.md"],
    usefulness:
      "Agreeing notes must not surface in a contradiction review, even if the model relates them.",
    script: relatePositive.script,
    expect: { abstained: true, relationships: [], changes: [] },
  },
  faulted(contradictionPositive, "provider-failure"),
  faulted(contradictionPositive, "permission-change"),

  // synthesize
  synthesisPositive,
  {
    id: "synthesize/positive-consensus",
    pipeline: "synthesize",
    kind: "positive",
    sources: ["Inbox/Raft.md", "Inbox/Lease.md"],
    usefulness: "Explains how leases depend on Raft's single leader; both captures cited.",
    script: synthesisScript(
      "Leader leases in Raft",
      { path: "Inbox/Raft.md", quote: QUOTES.raft },
      { path: "Inbox/Lease.md", quote: QUOTES.lease },
      "Because Raft guarantees a single leader per term, that leader can hold a lease and answer reads locally for as long as its clock bound is valid.",
    ),
    expect: {
      evidence: [
        { path: "Inbox/Raft.md", quote: QUOTES.raft },
        { path: "Inbox/Lease.md", quote: QUOTES.lease },
      ],
      changes: ["create"],
      findingKinds: ["synthesis"],
    },
  },
  {
    id: "synthesize/abstain-unrelated",
    pipeline: "synthesize",
    kind: "abstain",
    sources: ["Garden.md", "Projects/Storage.md"],
    usefulness: "A draft joining gardening and storage would be fabricated connection.",
    script: () => ({ title: "", sections: [], abstention: "The sources share no subject." }),
    expect: { abstained: true, changes: [], unrelatedPaths: ["Garden.md"] },
  },
  {
    id: "synthesize/abstain-single-source",
    pipeline: "synthesize",
    kind: "abstain",
    sources: ["Garden.md"],
    usefulness: "One note with no relevant companion cannot be synthesized.",
    script: () => ({ title: "", sections: [], abstention: "Only one relevant source." }),
    expect: { abstained: true, changes: [], unrelatedPaths: ["Garden.md"] },
  },
  faulted(synthesisPositive, "interruption"),
  faulted(synthesisPositive, "stale-source"),

  // inbox
  inboxPositive,
  {
    id: "inbox/positive-organize-and-tag",
    pipeline: "inbox",
    kind: "positive",
    sources: ["Inbox/Lease.md"],
    usefulness:
      "Routes the capture and adds a retrieval tag; the completion marker is the last effect.",
    script: inboxScript("Inbox/Lease.md", QUOTES.lease, "Raft leader leases", ["consensus"]),
    expect: {
      evidence: [{ path: "Inbox/Lease.md", quote: QUOTES.lease }],
      changes: ["properties", "move", "properties"],
      findingKinds: ["inbox", "metadata"],
    },
  },
  {
    id: "inbox/abstain-fragment-stays",
    pipeline: "inbox",
    kind: "abstain",
    sources: ["Inbox/Fragment.md"],
    usefulness:
      "An ambiguous fragment stays in the inbox with an explanation, unmoved and unmarked.",
    script: (_stage, at) => ({
      items: [
        {
          note: at("Inbox/Fragment.md"),
          category: "unclassified",
          decision: "needs-information",
          title: "",
          explanation: "The capture names no subject or person.",
          evidence: [{ note: at("Inbox/Fragment.md"), quote: QUOTES.fragment }],
        },
      ],
      abstention: "The capture needs more information.",
    }),
    expect: { changes: [], relationships: [], findingKinds: ["inbox"] },
  },
  {
    id: "inbox/abstain-already-processed",
    pipeline: "inbox",
    kind: "abstain",
    sources: ["Inbox/Done.md"],
    usefulness: "A processed item is skipped before any inference is spent.",
    script: () => {
      throw new Error("an already processed item must not reach the model");
    },
    expect: { abstained: true, changes: [], modelCalls: 0 },
  },
  faulted(inboxPositive, "provider-failure"),
  faulted(inboxPositive, "permission-change"),

  // archive
  archivePositive,
  {
    id: "archive/positive-superseded",
    pipeline: "archive",
    kind: "positive",
    sources: ["Projects/Old cache plan.md", "Projects/Cache plan.md"],
    usefulness: "Cites both the supersession statement and the replacement that covers the topic.",
    script: (_stage, at) => ({
      reviews: [
        {
          note: at("Projects/Old cache plan.md"),
          judgment: "superseded",
          explanation:
            "Old cache plan names its replacement, which defines the current invalidation rule.",
          evidence: [
            { note: at("Projects/Old cache plan.md"), quote: QUOTES.superseded },
            { note: at("Projects/Cache plan.md"), quote: QUOTES.cacheRevision },
          ],
        },
      ],
      abstention: null,
    }),
    expect: {
      evidence: [
        { path: "Projects/Old cache plan.md", quote: QUOTES.superseded },
        { path: "Projects/Cache plan.md", quote: QUOTES.cacheRevision },
      ],
      changes: ["archive"],
      findingKinds: ["archive"],
    },
  },
  {
    id: "archive/abstain-protected-and-open",
    pipeline: "archive",
    kind: "abstain",
    sources: ["Reference/Evergreen.md", "Projects/Active work.md"],
    usefulness: "A protected tag and an unfinished task exclude notes before any inference.",
    script: () => {
      throw new Error("ineligible notes must not reach the model");
    },
    expect: { abstained: true, changes: [], modelCalls: 0 },
  },
  {
    id: "archive/abstain-old-but-current",
    pipeline: "archive",
    kind: "abstain",
    sources: ["History/Storage.md"],
    usefulness:
      "Age alone is not irrelevance: the dated policy is still the record of a live conflict.",
    script: (_stage, at) => ({
      reviews: [
        {
          note: at("History/Storage.md"),
          judgment: "retain",
          explanation: "History Storage records a production policy that is still referenced.",
          evidence: [{ note: at("History/Storage.md"), quote: QUOTES.sameService }],
        },
      ],
      abstention: null,
    }),
    expect: { abstained: true, changes: [] },
  },
  faulted(archivePositive, "provider-failure"),
  faulted(archivePositive, "stale-source"),
];
