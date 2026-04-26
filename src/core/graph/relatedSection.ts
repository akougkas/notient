function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface SectionLocation {
  start: number;
  bodyStart: number;
  bodyEnd: number;
}

function locateSection(content: string, heading: string): SectionLocation | null {
  const headingPattern = new RegExp(`(^|\\n)##\\s+${escapeRegex(heading)}\\s*\\n`);
  const match = headingPattern.exec(content);
  if (!match) return null;
  const start = match.index + (match[1] ? 1 : 0);
  const bodyStart = match.index + match[0].length;
  const nextHeadingPattern = /\n##\s+/g;
  nextHeadingPattern.lastIndex = bodyStart;
  const nextMatch = nextHeadingPattern.exec(content);
  const bodyEnd = nextMatch ? nextMatch.index : content.length;
  return { start, bodyStart, bodyEnd };
}

export function addRelatedLink(content: string, heading: string, link: string): string {
  const location = locateSection(content, heading);
  if (!location) {
    const trailing = content.endsWith("\n") ? "" : "\n";
    return `${content}${trailing}\n## ${heading}\n- ${link}\n`;
  }
  const body = content.slice(location.bodyStart, location.bodyEnd);
  if (body.includes(link)) return content;
  const trimmed = body.replace(/\s+$/, "");
  const updatedBody = trimmed.length > 0 ? `${trimmed}\n- ${link}\n` : `- ${link}\n`;
  return content.slice(0, location.bodyStart) + updatedBody + content.slice(location.bodyEnd);
}

export function removeRelatedLink(content: string, heading: string, link: string): string {
  const location = locateSection(content, heading);
  if (!location) return content;
  const body = content.slice(location.bodyStart, location.bodyEnd);
  const linePattern = new RegExp(`(^|\\n)-\\s+${escapeRegex(link)}\\s*(\\n|$)`);
  const next = body.replace(linePattern, (_match, before, after) => (before && after ? "\n" : ""));
  if (next.trim().length === 0) {
    return content.slice(0, location.start) + content.slice(location.bodyEnd).replace(/^\n+/, "");
  }
  return content.slice(0, location.bodyStart) + next + content.slice(location.bodyEnd);
}
