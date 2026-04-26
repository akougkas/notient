export interface LLMEndpointConfig {
  baseUrl: string;
  reasoningModel: string;
  embeddingModel: string;
  fastModel: string;
  rerankerModel: string;
}

export interface NotientSettings {
  primary: LLMEndpointConfig;
  deep: LLMEndpointConfig;
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
  };
  approvals: {
    confidenceThreshold: number;
  };
}

export const DEFAULT_SETTINGS: NotientSettings = {
  primary: {
    baseUrl: "http://192.168.86.143:1234/v1",
    reasoningModel: "qwen3.6-35b-a3b",
    embeddingModel: "text-embedding-nomic-embed-text-v2-moe",
    fastModel: "qwen3.5-2b",
    rerankerModel: "granite-4.0-h-350m",
  },
  deep: {
    baseUrl: "http://192.168.86.141:8080/v1",
    reasoningModel: "Qwen3.6-35B-A3B-UD-Q5_K_XL",
    embeddingModel: "",
    fastModel: "",
    rerankerModel: "",
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
  },
  approvals: {
    confidenceThreshold: 0.6,
  },
};
