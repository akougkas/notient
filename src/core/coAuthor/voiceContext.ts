import type { Database } from "../db/database";

export interface VoiceContextOptions {
  excludePath: string | null;
  max: number;
  snippetChars: number;
}

export interface VoiceSnippet {
  path: string;
  text: string;
}

export interface VoiceContext {
  snippets: VoiceSnippet[];
}

export function buildVoiceContext(db: Database, options: VoiceContextOptions): VoiceContext {
  const rows = db.query<{ path: string; word_count: number; updated_at: number }>(
    `SELECT path, word_count, updated_at
     FROM notes
     WHERE maturity IN ('mature','synthesis-ready') AND word_count >= 100
       AND (? IS NULL OR path != ?)
     ORDER BY updated_at DESC
     LIMIT 24;`,
    [options.excludePath, options.excludePath],
  );
  const ranked = rows.slice(0, options.max);
  const snippets: VoiceSnippet[] = [];
  for (const row of ranked) {
    const chunks = db.query<{ text: string }>(
      "SELECT text FROM chunks WHERE note_path = ? ORDER BY ord LIMIT 1;",
      [row.path],
    );
    if (chunks.length === 0) continue;
    snippets.push({
      path: row.path,
      text: chunks[0].text.slice(0, options.snippetChars),
    });
  }
  return { snippets };
}
