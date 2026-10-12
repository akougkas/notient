import { intelligenceRecordId, parseAllIntelligenceRecords } from "../../core/intelligence";

export function visibleNoteText(text: string): string {
  let ids: Set<string>;
  try {
    ids = new Set(parseAllIntelligenceRecords(text).map(intelligenceRecordId));
  } catch {
    return text;
  }
  if (ids.size === 0) return text;
  let fence: { char: string; length: number } | null = null;
  return text.split(/(?<=\n)/u).filter((line) => {
    const match = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)/u.exec(line);
    if (fence === null && match) {
      fence = { char: match[1]![0]!, length: match[1]!.length };
      return true;
    }
    if (fence !== null) {
      if (match && match[1]?.[0] === fence.char && match[1].length >= fence.length && !match[2]?.trim())
        fence = null;
      return true;
    }
    const marker = /^<!-- notient-intelligence:v1:(?:start:(i-[a-f0-9]{64}):[A-Za-z0-9_-]+|end:(i-[a-f0-9]{64})) -->(?:\r?\n)?$/u.exec(line);
    return !marker || !ids.has(marker[1] ?? marker[2] ?? "");
  }).join("");
}
