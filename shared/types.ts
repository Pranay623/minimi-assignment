export type TurnStatus = 'pending' | 'complete' | 'failed' | 'cancelled';

export interface Source {
  id: string;
  url: string;
  title: string;
  excerpt: string;
  observedAt: string;
  publishedAt?: string;
  query: string;
  historical: boolean;
}

export interface MemoryReference {
  turnId: string;
  conversationId: string;
  question: string;
  createdAt: string;
  reason: 'date' | 'lexical' | 'recent';
}

export interface SearchRecord {
  query: string;
  status: 'searching' | 'complete' | 'failed';
  resultCount?: number;
  elapsedMs?: number;
  error?: string;
}

export interface RunStats {
  durationMs: number;
  firstTokenMs: number | null;
  modelCalls: number;
  searchQueries: number;
  inputTokens: number;
  outputTokens: number;
}

export interface Turn {
  id: string;
  conversationId: string;
  question: string;
  answer: string;
  status: TurnStatus;
  createdAt: string;
  sources: Source[];
  memory: MemoryReference[];
  searches: SearchRecord[];
  warnings: string[];
  stats: RunStats | null;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  demo: boolean;
}

export type AgentEvent =
  | { type: 'status'; message: string }
  | { type: 'memory'; references: MemoryReference[]; note: string | null }
  | { type: 'search'; search: SearchRecord }
  | { type: 'sources'; sources: Source[] }
  | { type: 'delta'; text: string }
  | { type: 'answer'; text: string }
  | { type: 'warning'; message: string }
  | { type: 'done'; turn: Turn }
  | { type: 'error'; message: string };

export interface AppConfig {
  live: boolean;
  missingKeys: string[];
  model: string;
  provider?: 'openai' | 'google' | 'agentrouter';
}
