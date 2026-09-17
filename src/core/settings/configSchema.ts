import { z } from "zod";
import { backgroundSchema, defaultBackgroundSettings } from "../../api/background";
import { chatBudgetSchema } from "../../api/chat";
import {
  DEFAULT_CHAT_BUDGET,
  DEFAULT_NOTIENT_CONFIG,
  type NotientConfig,
  TOOL_POLICY_NAMES,
} from "./types";

const finiteNumber = z.number().finite();
const positiveNumber = finiteNumber.gt(0);
const nonNegativeNumber = finiteNumber.min(0);
const nonEmptyString = z
  .string()
  .refine((value) => value.trim().length > 0, "expected a non-empty string");
const uniqueStrings = z
  .array(nonEmptyString)
  .max(256)
  .refine((values) => new Set(values).size === values.length, "expected unique entries");

const toolPolicyShape = Object.fromEntries(
  TOOL_POLICY_NAMES.map((name) => [name, z.enum(["auto", "ask"])]),
) as Record<(typeof TOOL_POLICY_NAMES)[number], z.ZodEnum<{ auto: "auto"; ask: "ask" }>>;

const vitalsSchema = z.strictObject({
  freshnessHalfLifeDays: positiveNumber.max(3_650),
  healthWeights: z
    .strictObject({
      wordBand: nonNegativeNumber.max(100),
      chunkCoverage: nonNegativeNumber.max(100),
      hasApprovedEdges: nonNegativeNumber.max(100),
    })
    .refine(
      (weights) => weights.wordBand + weights.chunkCoverage + weights.hasApprovedEdges > 0,
      "at least one health weight must be greater than zero",
    ),
  connectivityThresholds: z
    .strictObject({
      sparse: z.number().int().min(0).max(1_000_000),
      connected: z.number().int().min(0).max(1_000_000),
      hub: z.number().int().min(0).max(1_000_000),
    })
    .superRefine((thresholds, context) => {
      if (thresholds.sparse > thresholds.connected) {
        context.addIssue({
          code: "custom",
          path: ["connected"],
          message: "must be greater than or equal to sparse",
        });
      }
      if (thresholds.connected > thresholds.hub) {
        context.addIssue({
          code: "custom",
          path: ["hub"],
          message: "must be greater than or equal to connected",
        });
      }
    }),
  writeToFrontmatter: z.boolean(),
});

const searchSchema = z.strictObject({
  defaultMode: z.enum(["quick", "balanced", "deep"]),
  balanced: z
    .strictObject({
      topK: z.number().int().min(1).max(1_000),
      rerankTopN: z.number().int().min(1).max(1_000),
    })
    .refine((balanced) => balanced.rerankTopN <= balanced.topK, {
      path: ["rerankTopN"],
      message: "must be less than or equal to topK",
    }),
  deep: z.strictObject({ synthesisEnabled: z.boolean() }),
});

const chatSchema = z.strictObject({
  budget: chatBudgetSchema.default(() => ({ ...DEFAULT_CHAT_BUDGET })),
  approvalMode: z.enum(["safe", "yolo"]),
  persistReasoning: z.boolean(),
  perTool: z.strictObject(toolPolicyShape),
  history: z
    .strictObject({
      maxEntries: z.number().int().min(1).max(10_000_000),
      maxPerTarget: z.number().int().min(1).max(10_000_000),
    })
    .refine((history) => history.maxPerTarget <= history.maxEntries, {
      path: ["maxPerTarget"],
      message: "must be less than or equal to maxEntries",
    }),
  maxRoundsPerTurn: z.number().int().min(1).max(128),
  contextBudgetFraction: positiveNumber.max(1),
  context: z.strictObject({
    includeVaultSnapshot: z.boolean(),
    includeCrossSessionMemory: z.boolean(),
    crossSessionTopK: z.number().int().min(0).max(1_000),
    crossSessionSimThreshold: nonNegativeNumber.max(1),
    pinnedNoteMaxTokens: z.number().int().min(1).max(10_000_000),
  }),
});

const indexerSchema = z.strictObject({
  excludePaths: uniqueStrings,
  excludeGlobs: uniqueStrings,
  debounceMs: z.number().int().min(0).max(600_000),
  concurrency: z.strictObject({
    embed: z.number().int().min(1).max(128),
    extract: z.number().int().min(1).max(128),
  }),
  chunk: z
    .strictObject({
      targetTokens: z.number().int().min(1).max(1_000_000),
      maxTokens: z.number().int().min(1).max(1_000_000),
    })
    .refine((chunk) => chunk.maxTokens >= chunk.targetTokens, {
      path: ["maxTokens"],
      message: "must be greater than or equal to targetTokens",
    }),
});

/** The only runtime schema for persisted product configuration. */
export const notientConfigSchema = z.strictObject({
  // Additive product setting: older configurations opt into no AI work.
  background: backgroundSchema.default(defaultBackgroundSettings),
  vitals: vitalsSchema,
  search: searchSchema,
  chat: chatSchema,
  indexer: indexerSchema,
  surrealdb: z.strictObject({
    hnswCacheMib: z.number().int().min(1).max(1_048_576),
    logLevel: z.enum(["trace", "debug", "info", "warn", "error"]),
  }),
  agentEvents: z.strictObject({
    maxRows: z.number().int().min(1).max(100_000_000),
  }),
});

export interface ConfigSource {
  /** Human-readable source path included in every validation error. */
  readonly path: string;
  /** Returns null only when the file does not exist. Other read errors throw. */
  load(): Promise<string | null>;
}

export class NotientConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotientConfigError";
  }
}

/**
 * Parse one existing config.json without merging, coercing, or discarding
 * anything. Every object is strict and every persisted field is required.
 */
export function parseNotientConfig(raw: string, sourcePath: string): NotientConfig {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new NotientConfigError(`notient: ${sourcePath}: malformed JSON: ${detail}`);
  }

  const result = notientConfigSchema.safeParse(decoded);
  if (!result.success) {
    const failures = result.error.issues.flatMap((issue) => formatIssue(sourcePath, issue));
    throw new NotientConfigError(
      `notient: invalid configuration:\n${failures.map((failure) => `- ${failure}`).join("\n")}`,
    );
  }
  return deepFreeze(result.data as NotientConfig);
}

/** Missing config uses a fresh canonical default; malformed existing config throws. */
export async function loadNotientConfig(source: ConfigSource): Promise<NotientConfig> {
  const raw = await source.load();
  if (raw === null) return deepFreeze(structuredClone(DEFAULT_NOTIENT_CONFIG));
  return parseNotientConfig(raw, source.path);
}

/** Runtime immutability guard shared by the config loader and boot snapshot. */
export function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function formatIssue(sourcePath: string, issue: z.core.$ZodIssue): string[] {
  if (issue.code === "unrecognized_keys") {
    return issue.keys.map((key) => `${formatPath(sourcePath, [...issue.path, key])}: unknown key`);
  }
  return [`${formatPath(sourcePath, issue.path)}: ${issue.message}`];
}

function formatPath(sourcePath: string, segments: PropertyKey[]): string {
  if (segments.length === 0) return sourcePath;
  return `${sourcePath}.${segments.map(String).join(".")}`;
}
