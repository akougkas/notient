export interface NotientFrontmatter {
  vitals?: { health: number; maturity: string; freshness: number };
  edges?: Array<{
    type: string;
    target: string;
    confidence: number;
    evidence?: string;
  }>;
  summary?: string;
  updated?: string;
}

const FENCE = "---";

export function extractNotientBlock(content: string): string | null {
  const fm = readRawFrontmatter(content);
  if (!fm) return null;
  return findNotientSubblock(fm.yaml);
}

export function upsertNotientBlock(content: string, block: NotientFrontmatter): string {
  const formatted = formatNotientBlock(block);
  const fm = readRawFrontmatter(content);
  if (!fm) {
    return `${FENCE}\n${formatted}${FENCE}\n${content}`;
  }
  const existing = findNotientSubblock(fm.yaml);
  const newYaml = existing
    ? fm.yaml.replace(existing, formatted)
    : appendBlockToYaml(fm.yaml, formatted);
  return `${FENCE}\n${newYaml}${FENCE}\n${fm.body}`;
}

export function formatNotientBlock(block: NotientFrontmatter): string {
  let out = "notient:\n";
  if (block.vitals) {
    out += "  vitals:\n";
    out += `    health: ${block.vitals.health}\n`;
    out += `    maturity: ${block.vitals.maturity}\n`;
    out += `    freshness: ${block.vitals.freshness}\n`;
  }
  if (block.edges && block.edges.length > 0) {
    out += "  edges:\n";
    for (const edge of block.edges) {
      out += `    - ${formatEdgeInline(edge)}\n`;
    }
  }
  if (block.summary !== undefined) {
    out += `  summary: ${formatScalar(block.summary)}\n`;
  }
  if (block.updated !== undefined) {
    out += `  updated: ${formatScalar(block.updated)}\n`;
  }
  return out;
}

function formatEdgeInline(edge: NonNullable<NotientFrontmatter["edges"]>[number]): string {
  const parts = [
    `type: ${edge.type}`,
    `target: ${formatScalar(edge.target)}`,
    `confidence: ${edge.confidence}`,
  ];
  if (edge.evidence !== undefined) parts.push(`evidence: ${formatScalar(edge.evidence)}`);
  return `{ ${parts.join(", ")} }`;
}

function formatScalar(value: string | number | boolean): string {
  if (typeof value !== "string") return String(value);
  if (/:\s|[#\n,{}[\]]|^\s|\s$/.test(value)) return JSON.stringify(value);
  return value;
}

interface RawFrontmatter {
  yaml: string;
  body: string;
}

function readRawFrontmatter(content: string): RawFrontmatter | null {
  if (!content.startsWith(`${FENCE}\n`) && !content.startsWith(`${FENCE}\r\n`)) return null;
  const headerLen = content.startsWith(`${FENCE}\n`) ? FENCE.length + 1 : FENCE.length + 2;
  const closeIdx = content.indexOf(`\n${FENCE}`, headerLen);
  if (closeIdx === -1) return null;
  const yaml = content.slice(headerLen, closeIdx + 1);
  const after = closeIdx + 1 + FENCE.length;
  const body = content.slice(after).replace(/^\r?\n/, "");
  return { yaml, body };
}

function findNotientSubblock(yaml: string): string | null {
  const startMatch = yaml.match(/^notient:\s*\n/m);
  if (!startMatch) return null;
  const startIdx = startMatch.index ?? 0;
  let endIdx = yaml.length;
  let cursor = startIdx + startMatch[0].length;
  while (cursor < yaml.length) {
    const lineEnd = yaml.indexOf("\n", cursor);
    const line = lineEnd === -1 ? yaml.slice(cursor) : yaml.slice(cursor, lineEnd + 1);
    if (line.length === 0) break;
    const isContinuation = line.startsWith("  ") || line.trim() === "";
    if (!isContinuation) {
      endIdx = cursor;
      break;
    }
    cursor = lineEnd === -1 ? yaml.length : lineEnd + 1;
    if (lineEnd === -1) {
      endIdx = yaml.length;
      break;
    }
  }
  if (cursor >= yaml.length) endIdx = yaml.length;
  return yaml.slice(startIdx, endIdx);
}

function appendBlockToYaml(yaml: string, block: string): string {
  if (yaml.length === 0) return block;
  return yaml.endsWith("\n") ? yaml + block : `${yaml}\n${block}`;
}
