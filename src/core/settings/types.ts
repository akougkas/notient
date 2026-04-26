export interface LLMEndpointConfig {
  baseUrl: string;
  reasoningModel: string;
  embeddingModel: string;
  fastModel: string;
  rerankerModel: string;
}

export interface EmbeddingEndpointConfig {
  baseUrl: string;
  model: string;
}

export interface NotientSettings {
  primary: LLMEndpointConfig;
  deep: LLMEndpointConfig;
  embedding: EmbeddingEndpointConfig;
  agents: {
    linker: boolean;
    synthesizer: boolean;
    contradictionHunter: boolean;
    maturityAdvancer: boolean;
  };
  coAuthor: {
    enabled: boolean;
    minWords: number;
    debounceMs: number;
    /** Prose-friendly non-reasoning model. Reasoning models stall behind their CoT. */
    model: string;
  };
  approvals: {
    confidenceThreshold: number;
  };
  awakenedAt: number | null;
}

// Phase 4 substrate: ONLY mini. ONLY two models — nemotron-cascade for chat/reasoning,
// nomic-embed-text-v2-moe for embeddings. The mini server has VRAM for exactly these
// two models at once. `primary` and `deep` both point at the same llama-server endpoint
// using the same chat model; `embedding` points at the Ollama OpenAI-compatible
// endpoint on the same node. Agents, co-author, fast paths, and reranking all share
// the single chat model.
const MINI_LLAMA_SERVER = "http://192.168.86.141:8080/v1";
const MINI_OLLAMA = "http://192.168.86.141:11434/v1";
const MINI_CHAT_MODEL = "Nemotron-Cascade-2-30B-A3B-i1-Q4_K_M";
const MINI_EMBEDDING_MODEL = "nomic-embed-text-v2-moe";

export const DEFAULT_SETTINGS: NotientSettings = {
  primary: {
    baseUrl: MINI_LLAMA_SERVER,
    reasoningModel: MINI_CHAT_MODEL,
    embeddingModel: MINI_EMBEDDING_MODEL, // legacy; embedding endpoint reads from `embedding.*` below
    fastModel: MINI_CHAT_MODEL,
    rerankerModel: MINI_CHAT_MODEL,
  },
  deep: {
    baseUrl: MINI_LLAMA_SERVER,
    reasoningModel: MINI_CHAT_MODEL,
    embeddingModel: MINI_EMBEDDING_MODEL,
    fastModel: MINI_CHAT_MODEL,
    rerankerModel: MINI_CHAT_MODEL,
  },
  embedding: {
    baseUrl: MINI_OLLAMA,
    model: MINI_EMBEDDING_MODEL,
  },
  agents: {
    linker: true,
    synthesizer: true,
    contradictionHunter: true,
    maturityAdvancer: true,
  },
  coAuthor: {
    enabled: true,
    minWords: 100,
    debounceMs: 5000,
    model: MINI_CHAT_MODEL,
  },
  approvals: {
    confidenceThreshold: 0.6,
  },
  awakenedAt: null,
};
