import type { Generated, Insertable, Selectable, Updateable } from "kysely";

export interface Database {
  notes: NoteTable;
  note_tags: NoteTagTable;
  note_meta: NoteMetaTable;
  chunks: ChunkTable;
  embeddings: EmbeddingTable;
  actions: ActionTable;
  messages: MessageTable;
  intelligence: IntelligenceTable;
}

export interface NoteTable {
  path: string;
  hash: string;
  mtime: number;
  title: string | null;
  health_score: number | null;
  para_type: string | null;
  word_count: number | null;
}

export interface NoteTagTable {
  note_path: string;
  tag: string;
}

export interface NoteMetaTable {
  note_path: string;
  key: string;
  value_type: "text" | "number" | "bool" | "date";
  value_text: string | null;
  value_number: number | null;
}

export interface ChunkTable {
  id: string;
  note_path: string;
  tier: "note" | "section" | "block";
  kind: string; // 'paragraph' | 'list' | 'code' | etc.
  parent_chunk_id: string | null;
  heading_path: string | null; // JSON array
  text: string;
  start_line: number | null;
  end_line: number | null;
}

export interface EmbeddingTable {
  chunk_id: string;
  model_key: string;
  dimension: number;
  vector: Uint8Array; // Float32Array as blob
}

export interface ActionTable {
  id: string;
  task_id: string | null;
  workflow_id: string | null;
  type: string;
  risk: string;
  note_path: string | null;
  title: string;
  reason: string;
  reasoning: string;
  created_at: number;
  applied_at: number | null;
  undone_at: number | null;
  status: string;
  payload: string; // JSON - action payload
  undo_payload: string; // JSON - undo data
  changed_paths: string; // JSON array
}

export interface MessageTable {
  id: string;
  note_path: string | null;
  role: string;
  content: string;
  thinking: string | null;
  created_at: number;
  attachments: string | null; // JSON array
  status: string | null; // 'success' | 'failed' | 'cancelled'
  reasoning_summary: string | null;
  action_ref: string | null;
}

export interface IntelligenceTable {
  note_path: string;
  topic: string; // Topic bucket for grouping
  content_hash: string;
  model_key: string;
  data: string; // Full IntelligenceRecord as JSON
  updated_at: number;
}

// Helpers
export type Note = Selectable<NoteTable>;
export type NewNote = Insertable<NoteTable>;
export type NoteUpdate = Updateable<NoteTable>;

export type Chunk = Selectable<ChunkTable>;
export type NewChunk = Insertable<ChunkTable>;
export type ChunkUpdate = Updateable<ChunkTable>;

export type Action = Selectable<ActionTable>;
export type NewAction = Insertable<ActionTable>;
export type ActionUpdate = Updateable<ActionTable>;
