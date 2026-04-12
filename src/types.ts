export type MemoryType = 'decision' | 'debugging' | 'convention' | 'architecture';
export type Confidence = 'low' | 'medium' | 'high';
export type WorkingNoteType =
  | 'observation'
  | 'decision'
  | 'debugging'
  | 'convention'
  | 'hypothesis'
  | 'question';

export interface WorkingNote {
  ts: string;
  session_id: string;
  agent_id: string;
  type: WorkingNoteType;
  content: string;
  tags: string[];
  confidence: Confidence;
}

export interface MainEntrySource {
  session: string;
  agents: string[];
}

export interface MainEntry {
  id?: number;
  type: MemoryType;
  title: string;
  content: string;
  tags: string[];
  confidence: Confidence;
  created_at: string;
  last_verified: string;
  superseded_by?: number | null;
  sources: MainEntrySource[];
  file_path: string;
}

export interface Session {
  id: string;
  name?: string;
  started_at: string;
  ended_at?: string;
  consolidated_at?: string;
}

export interface ConsolidationAction {
  working_note_index: number;
  action: 'PROMOTE' | 'MERGE' | 'SUPERSEDE' | 'DISCARD';
  target_entry_id: number | null;
  new_entry: Omit<
    MainEntry,
    'id' | 'created_at' | 'last_verified' | 'sources' | 'file_path' | 'superseded_by'
  > | null;
  rationale: string;
}

export interface SearchResult {
  id: number;
  title: string;
  snippet: string;
  file_path: string;
  last_verified: string;
  confidence: Confidence;
}

export interface Correction {
  ts: string;
  session_id?: string;
  agent_id?: string;
  context?: string;
  agent_did: string;
  user_corrected_to: string;
  rationale: string;
}
