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

export function readFrontmatter(content: string): {
  frontmatter: Record<string, unknown> | null;
  body: string;
} {
  if (!content.startsWith(FENCE)) return { frontmatter: null, body: content };
  const end = content.indexOf(`\n${FENCE}`, FENCE.length);
  if (end === -1) return { frontmatter: null, body: content };
  const yaml = content.slice(FENCE.length, end).trim();
  const body = content.slice(end + FENCE.length + 1).replace(/^\n/, "");
  return { frontmatter: parseYaml(yaml), body };
}

export function writeFrontmatter(body: string, frontmatter: Record<string, unknown>): string {
  if (Object.keys(frontmatter).length === 0) return body;
  return `${FENCE}\n${stringifyYaml(frontmatter)}${FENCE}\n${body}`;
}

export function mergeNotientBlock(
  existing: Record<string, unknown> | null,
  notient: NotientFrontmatter,
): Record<string, unknown> {
  return { ...(existing ?? {}), notient };
}

// Minimal YAML for the keys we control (Notient block + simple top-level scalars).
// We do NOT round-trip arbitrary YAML; we preserve unknown keys verbatim by treating
// them as opaque strings.
export function parseYaml(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) {
      i++;
      continue;
    }
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      i++;
      continue;
    }
    const [, key, raw] = match;
    if (raw === "" && lines[i + 1]?.startsWith("  ")) {
      const block: string[] = [];
      i++;
      while (i < lines.length && (lines[i].startsWith("  ") || lines[i].trim() === "")) {
        block.push(lines[i].slice(2));
        i++;
      }
      out[key] = parseYaml(block.join("\n"));
      continue;
    }
    out[key] = parseScalar(raw);
    i++;
  }
  return out;
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null" || trimmed === "") return null;
  if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/.test(trimmed)) return Number.parseFloat(trimmed);
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function stringifyYaml(obj: Record<string, unknown>, indent = 0): string {
  const pad = "  ".repeat(indent);
  let out = "";
  for (const [key, value] of Object.entries(obj)) {
    out += stringifyEntry(key, value, pad, indent);
  }
  return out;
}

function stringifyEntry(key: string, value: unknown, pad: string, indent: number): string {
  if (value === null || value === undefined) return `${pad}${key}: null\n`;
  if (Array.isArray(value)) return `${pad}${key}:\n${stringifyArray(value, pad)}`;
  if (typeof value === "object") {
    const nested = stringifyYaml(value as Record<string, unknown>, indent + 1);
    return `${pad}${key}:\n${nested}`;
  }
  return `${pad}${key}: ${formatScalar(value)}\n`;
}

function stringifyArray(items: unknown[], pad: string): string {
  let out = "";
  for (const item of items) {
    if (typeof item === "object" && item !== null) {
      out += `${pad}  - ${inlineObject(item as Record<string, unknown>)}\n`;
    } else {
      out += `${pad}  - ${formatScalar(item)}\n`;
    }
  }
  return out;
}

function inlineObject(obj: Record<string, unknown>): string {
  const pairs = Object.entries(obj).map(([k, v]) => `${k}: ${formatScalar(v)}`);
  return `{ ${pairs.join(", ")} }`;
}

function formatScalar(value: unknown): string {
  if (typeof value === "string") {
    if (/[:#\n,{}[\]]/.test(value)) return JSON.stringify(value);
    return value;
  }
  return String(value);
}
