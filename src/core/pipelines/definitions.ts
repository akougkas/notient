import type { PipelineId } from "../../api/operations";

export const PIPELINES = {
  "index-extract": {
    name: "Index and extract",
    purpose:
      "Refresh structure and configured embeddings; extract concepts, claims and questions grounded in exact source passages.",
    stages: ["read", "structure", "embeddings", "extract", "validate", "persist"],
    effects: [],
    model: "reasoning and optional embeddings",
  },
  enrich: {
    name: "Enrich notes",
    purpose:
      "Suggest useful summaries, tags and aliases while preserving authored properties and sections.",
    stages: ["read", "inspect-metadata", "enrich", "validate", "preview"],
    effects: ["properties", "body"],
    model: "reasoning",
  },
  relate: {
    name: "Relate notes",
    purpose:
      "Find specific connections using lexical and graph candidates and evidence from both notes.",
    stages: ["read", "retrieve", "compare", "validate", "propose"],
    effects: ["relationships"],
    model: "reasoning",
  },
  contradictions: {
    name: "Find contradictions",
    purpose:
      "Compare claims across relevant notes, separating genuine conflict from changes over time or assumptions.",
    stages: ["read", "retrieve", "compare-claims", "validate", "propose"],
    effects: ["relationships"],
    model: "reasoning",
  },
  synthesize: {
    name: "Synthesize and create",
    purpose: "Create a cited draft or map of content from complementary source material.",
    stages: ["read", "coverage", "draft", "validate-citations", "preview"],
    effects: ["create"],
    model: "reasoning",
  },
  inbox: {
    name: "Process inbox",
    purpose:
      "Classify, enrich and relate inbox notes, then stage routing and optional derived notes as reviewable effects.",
    stages: ["read", "classify", "enrich", "retrieve", "relate", "route", "preview"],
    effects: ["properties", "body", "relationships", "move", "create"],
    model: "reasoning",
  },
  archive: {
    name: "Review for archive",
    purpose:
      "Identify completed, superseded or redundant notes with supporting evidence and safe reference-aware archive previews.",
    stages: ["read", "eligibility", "retrieve", "review", "preview-references"],
    effects: ["archive"],
    model: "reasoning",
  },
} as const satisfies Record<
  PipelineId,
  {
    name: string;
    purpose: string;
    stages: readonly string[];
    effects: readonly string[];
    model: string;
  }
>;
