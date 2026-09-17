import { NOTIENT_PROPOSALS_FOLDER, isNotientOwnedArtifactPath } from "../vault/publicPath";

export interface ProposalNoteInput {
  title: string;
  body: string;
  kind?: string;
}

export interface ProposalNotePlan {
  path: string;
  content: string;
  title: string;
  kind: string;
  proposedBy: string;
  proposedAt: string;
}

const TITLE_MAX_CHARS = 200;
const BODY_MAX_CHARS = 1_000_000;
const KIND_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const CLIENT_IDENTITY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Lowercase filename seed with one canonical 60-character ceiling. */
export function proposalSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "untitled";
}

/** Validate the untrusted RPC payload before deriving any internal path. */
export function parseProposalNoteInput(raw: Record<string, unknown>): ProposalNoteInput {
  if (!hasExactOptionalKeys(raw, ["title", "body", "kind"])) {
    throw new Error("proposal note requires exactly title, body, and optional kind");
  }
  const title = raw.title;
  if (
    typeof title !== "string" ||
    title.length === 0 ||
    title.trim() !== title ||
    title.length > TITLE_MAX_CHARS ||
    containsControlCharacter(title)
  ) {
    throw new Error(`title must be an exact non-empty string up to ${TITLE_MAX_CHARS} characters`);
  }
  const body = raw.body;
  if (typeof body !== "string" || body.length > BODY_MAX_CHARS || body.includes("\u0000")) {
    throw new Error(`body must be a string up to ${BODY_MAX_CHARS} characters without NUL bytes`);
  }
  const kind = raw.kind;
  if (kind !== undefined && (typeof kind !== "string" || !KIND_PATTERN.test(kind))) {
    throw new Error(`kind must match ${KIND_PATTERN.source}`);
  }
  return kind === undefined ? { title, body } : { title, body, kind };
}

/** Build the one server-authored Markdown representation for a proposal note. */
export function buildProposalNotePlan(options: {
  input: ProposalNoteInput;
  proposedBy: string;
  now: number;
}): ProposalNotePlan {
  if (!CLIENT_IDENTITY_PATTERN.test(options.proposedBy)) {
    throw new Error("proposal note requires a canonical authenticated client identity");
  }
  if (!Number.isSafeInteger(options.now) || options.now < 0) {
    throw new Error("proposal note clock must be a non-negative safe integer");
  }
  const instant = new Date(options.now);
  if (!Number.isFinite(instant.getTime())) throw new Error("proposal note clock is invalid");
  const proposedAt = instant.toISOString();
  const date = proposedAt.slice(0, 10);
  const kind = options.input.kind ?? "proposal";
  const path = `${NOTIENT_PROPOSALS_FOLDER}/${date}-${proposalSlug(options.input.title)}.md`;
  if (!isNotientOwnedArtifactPath(path)) {
    throw new Error("proposal note path derivation escaped its owned folder");
  }
  const content = [
    "---",
    `title: ${JSON.stringify(options.input.title)}`,
    "notient:",
    `  kind: ${JSON.stringify(kind)}`,
    `  proposedBy: ${JSON.stringify(options.proposedBy)}`,
    `  proposedAt: ${JSON.stringify(proposedAt)}`,
    "---",
    "",
    `# ${options.input.title}`,
    "",
    options.input.body,
    "",
  ].join("\n");
  return {
    path,
    content,
    title: options.input.title,
    kind,
    proposedBy: options.proposedBy,
    proposedAt,
  };
}

function hasExactOptionalKeys(raw: Record<string, unknown>, allowed: readonly string[]): boolean {
  return (
    Object.keys(raw).every((key) => allowed.includes(key)) &&
    Object.hasOwn(raw, "title") &&
    Object.hasOwn(raw, "body")
  );
}

function containsControlCharacter(raw: string): boolean {
  for (const character of raw) {
    const point = character.codePointAt(0);
    if (point !== undefined && (point < 32 || point === 127)) return true;
  }
  return false;
}
