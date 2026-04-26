export interface ParagraphSpan {
  from: number;
  to: number;
  text: string;
}

const MIN_PREFIX = 12;
const PREFIX_LEN = 80;

export function splitParagraphs(doc: string): ParagraphSpan[] {
  const result: ParagraphSpan[] = [];
  const regex = /\n{2,}/g;
  let cursor = 0;
  let match: RegExpExecArray | null = regex.exec(doc);
  while (match !== null) {
    const text = doc.slice(cursor, match.index);
    if (text.trim().length > 0) {
      result.push({ from: cursor, to: cursor + text.length, text });
    }
    cursor = match.index + match[0].length;
    match = regex.exec(doc);
  }
  const tail = doc.slice(cursor);
  if (tail.trim().length > 0) {
    result.push({ from: cursor, to: cursor + tail.length, text: tail });
  }
  return result;
}

export interface ChunkRef {
  id: string;
  text: string;
}

export function findChunkParagraphs(doc: string, chunks: ChunkRef[]): Map<string, ParagraphSpan> {
  const paragraphs = splitParagraphs(doc);
  const result = new Map<string, ParagraphSpan>();
  for (const chunk of chunks) {
    const prefix = chunk.text.trim().slice(0, PREFIX_LEN);
    if (prefix.length < MIN_PREFIX) continue;
    const paragraph = paragraphs.find((span) => span.text.includes(prefix));
    if (paragraph) result.set(chunk.id, paragraph);
  }
  return result;
}
