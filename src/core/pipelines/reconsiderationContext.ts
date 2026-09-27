import { contentRevision } from "../../api/notes";
import type { MethodologySettings } from "../../api/background";
import type { PipelinePolicy } from "../../api/operations";

export interface ReconsiderationContextReference {
  configurationRevision: string;
  reconsiderationContextRevision?: string;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
}

function stableScope(scope: PipelinePolicy["readScope"]): unknown {
  return {
    paths: [...scope.paths].sort(),
    folders: [...scope.folders].sort(),
    tags: [...scope.tags].sort(),
    excludeFolders: [...scope.excludeFolders].sort(),
    excludeTags: [...scope.excludeTags].sort(),
  };
}

export function reconsiderationContextRevision(
  policy: PipelinePolicy,
  methodology: MethodologySettings,
): string {
  return contentRevision(
    JSON.stringify(
      stableValue({
        policy: {
          mode: policy.mode,
          readScope: stableScope(policy.readScope),
          writeScope: stableScope(policy.writeScope),
          allowedSections: policy.allowedSections,
          effects: [...policy.effects].sort(),
          parameters: policy.parameters,
        },
        methodology: {
          mode: methodology.mode,
          name: methodology.name,
          conventions: methodology.conventions,
        },
      }),
    ),
  );
}

export function reconsiderationContextMatches(
  recorded: ReconsiderationContextReference,
  current: ReconsiderationContextReference,
): boolean {
  if (recorded.reconsiderationContextRevision && current.reconsiderationContextRevision)
    return recorded.reconsiderationContextRevision === current.reconsiderationContextRevision;
  return recorded.configurationRevision === current.configurationRevision;
}
