import { type PipelineId, type PipelinePolicy, pipelinePolicySchema } from "./operations";
import { pipelineEffects } from "./policyValidation";

export type PolicySection = "Basics" | "Scope" | "Schedule" | "Resources" | "Details";
export interface PolicyField {
  path: string;
  label: string;
  help: string;
  section: PolicySection;
  kind: "boolean" | "choice" | "number" | "text" | "lines" | "windows";
  choices?: readonly string[];
  scale?: number;
}
/** Shared presentation and parsing, over the same canonical policy. */
export function policyFields(pipeline: PipelineId): PolicyField[] {
  const fields: PolicyField[] = [
    {
      path: "enabled",
      label: "Background work",
      help: "Off until you explicitly enable it. Manual requests remain available.",
      section: "Basics",
      kind: "boolean",
    },
    {
      path: "mode",
      label: "Decision mode",
      help: "Report records findings; propose creates reviews; apply permits only the effects and scope below.",
      section: "Basics",
      kind: "choice",
      choices: ["report", "propose", "apply"],
    },
    {
      path: "triggers",
      label: "Run after",
      help: "One per line: save, idle, interval. Enabling a trigger permits future background inference.",
      section: "Basics",
      kind: "lines",
    },
    {
      path: "effects",
      label: "Automatic effects",
      help: `Only used in apply mode. One per line: ${pipelineEffects(pipeline).join(", ") || "none; derived indexing only"}.`,
      section: "Basics",
      kind: "lines",
    },
  ];
  for (const [scope, name] of [
    ["readScope", "Read"],
    ["writeScope", "Write"],
  ]) {
    for (const [key, label, help] of [
      [
        "folders",
        "folders",
        "Folder paths relative to the vault. Empty means any eligible folder.",
      ],
      ["paths", "exact notes", "Exact .md paths. Empty means any eligible note."],
      ["tags", "required tags", "All listed tags must be present."],
      ["excludeFolders", "excluded folders", "These folders always stay outside this scope."],
      ["excludeTags", "excluded tags", "Notes with any of these tags stay outside this scope."],
    ])
      fields.push({
        path: `${scope}.${key}`,
        label: `${name} ${label}`,
        help: `${help} One per line. All filters intersect.`,
        section: "Scope",
        kind: "lines",
      });
  }
  for (const [key, label] of [
    ["notes", "New notes folder"],
    ["inbox", "Inbox folder"],
    ["archive", "Archive folder"],
  ])
    fields.push({
      path: `destinations.${key}`,
      label,
      help: "Vault-relative folder. Leave empty for the vault root. Write scope still applies.",
      section: "Scope",
      kind: "text",
    });
  fields.push(
    {
      path: "timezone",
      label: "Timezone",
      help: "IANA timezone, for example America/Chicago. Operating windows use this timezone.",
      section: "Schedule",
      kind: "text",
    },
    {
      path: "windows",
      label: "Operating windows",
      help: "One per line: Mon,Tue,Wed,Thu,Fri 09:00-17:00. Empty means any time. Split overnight windows across days; 24:00 is allowed as an end.",
      section: "Schedule",
      kind: "windows",
    },
  );
  for (const [path, label] of [
    ["debounceMs", "Wait after save (seconds)"],
    ["cooldownMs", "Between runs (seconds)"],
    ["idleMs", "Idle for (seconds)"],
    ["intervalMs", "Interval (seconds)"],
  ])
    fields.push({
      path,
      label,
      help: "Timing is bounded and validated before save.",
      section: "Schedule",
      kind: "number",
      scale: 1000,
    });
  for (const [key, label, help, scale] of [
    ["notes", "Notes per run", "Maximum source notes, including retrieved context.", 1],
    ["candidates", "Retrieval candidates", "Maximum candidates considered by a run.", 1],
    ["modelCalls", "Model calls", "Maximum inference attempts per run, including retries.", 1],
    [
      "tokens",
      "Total token budget",
      "Prompt and generation accounting; measured usage and reserved estimates remain distinct.",
      1,
    ],
    [
      "generationTokens",
      "Generation ceiling",
      "Shared by reasoning and final output when the provider uses one ceiling. Qwen needs room for both.",
      1,
    ],
    [
      "durationMs",
      "Active time (seconds)",
      "Maximum active run duration; inference outages wait durably.",
      1000,
    ],
    [
      "concurrency",
      "Concurrent runs",
      "Per-workflow ceiling, also bounded by the shared reasoning scheduler.",
      1,
    ],
    [
      "retries",
      "Recovery attempts",
      "Bounded retries; refused requests and note effects are never blindly replayed.",
      1,
    ],
    ["priority", "Priority", "0–10. Higher priorities are admitted first.", 1],
  ] as const)
    fields.push({
      path: `budget.${key}`,
      label,
      help,
      section: "Resources",
      kind: "number",
      scale,
    });
  fields.push(
    {
      path: "allowedProperties",
      label: "Editable properties",
      help: "Exact property names, one per line; used by enrichment and automatic property effects.",
      section: "Details",
      kind: "lines",
    },
    {
      path: "allowedSections",
      label: "Editable sections",
      help: "Exact heading names, one per line. Automatic body appends must stay in these sections.",
      section: "Details",
      kind: "lines",
    },
    {
      path: "parameters.retrieval",
      label: "Retrieval",
      help: "Lexical works without embeddings; hybrid attempts semantic retrieval with a bounded lexical fallback.",
      section: "Details",
      kind: "choice",
      choices: ["lexical", "hybrid"],
    },
  );
  if (pipeline === "index-extract")
    fields.push(
      {
        path: "parameters.indexExtract.embeddings",
        label: "Create embeddings",
        help: "Requires a configured embedding provider. Structural watching remains independent.",
        section: "Details",
        kind: "boolean",
      },
      {
        path: "parameters.indexExtract.extraction",
        label: "Extract concepts and claims",
        help: "Uses the reasoning model and the run's inference budget.",
        section: "Details",
        kind: "boolean",
      },
    );
  if (pipeline === "synthesize")
    fields.push(
      {
        path: "parameters.synthesis.kind",
        label: "Synthesis style",
        help: "A cited draft or a map of content.",
        section: "Details",
        kind: "choice",
        choices: ["draft", "map"],
      },
      {
        path: "parameters.synthesis.maxWords",
        label: "Maximum draft words",
        help: "100–3000 words.",
        section: "Details",
        kind: "number",
      },
      {
        path: "parameters.synthesis.template",
        label: "Draft template",
        help: "Use {{title}}, {{body}} and {{sources}} exactly once each.",
        section: "Details",
        kind: "text",
      },
    );
  if (pipeline === "inbox")
    fields.push(
      {
        path: "parameters.inbox.createDerivedNotes",
        label: "Suggest derived notes",
        help: "Propose useful new notes from inbox material; writing still needs the configured authority.",
        section: "Details",
        kind: "boolean",
      },
      {
        path: "parameters.inbox.processedProperty",
        label: "Processed property",
        help: "Property set as each organized item's final effect, after its move succeeds. Items already carrying the processed value are skipped. It must also be an allowed property.",
        section: "Details",
        kind: "text",
      },
      {
        path: "parameters.inbox.processedValue",
        label: "Processed value",
        help: "Value written only through reviewed or explicitly permitted effects.",
        section: "Details",
        kind: "text",
      },
    );
  if (pipeline === "archive")
    fields.push(
      {
        path: "parameters.archive.minimumAgeDays",
        label: "Minimum age (days)",
        help: "Younger notes remain protected.",
        section: "Details",
        kind: "number",
      },
      {
        path: "parameters.archive.preserveOpenTasks",
        label: "Protect open tasks",
        help: "Notes with unfinished tasks remain active.",
        section: "Details",
        kind: "boolean",
      },
      {
        path: "parameters.archive.protectedTags",
        label: "Protected tags",
        help: "Never propose archiving notes with these tags. One per line.",
        section: "Details",
        kind: "lines",
      },
      {
        path: "parameters.archive.allowRedundant",
        label: "Review redundant notes",
        help: "Allow evidence-backed redundancy as a reason to suggest archiving.",
        section: "Details",
        kind: "boolean",
      },
    );
  return fields;
}
const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function policyFieldText(policy: PipelinePolicy, field: PolicyField): string {
  let value: unknown = policy;
  for (const key of field.path.split(".")) value = (value as Record<string, unknown>)[key];
  if (field.kind === "windows")
    return (value as PipelinePolicy["windows"])
      .map(
        (window) =>
          `${window.days.map((day) => days[day]).join(",")} ${clock(window.startMinute)}-${clock(window.endMinute)}`,
      )
      .join("\n");
  if (field.kind === "lines") return (value as string[]).join("\n");
  if (field.kind === "number") return String(Number(value) / (field.scale ?? 1));
  return String(value);
}
export function editPolicyField(
  policy: PipelinePolicy,
  field: PolicyField,
  text: string,
): PipelinePolicy {
  const next = structuredClone(policy);
  let value: unknown = text;
  if (field.kind === "number") {
    if (!text.trim() || !Number.isFinite(Number(text))) throw new Error("Enter a finite number.");
    value = Number(text) * (field.scale ?? 1);
  }
  if (field.kind === "boolean") value = text === "true";
  if (field.kind === "lines")
    value = text
      .split("\n")
      .map((v) => v.trim())
      .filter(Boolean);
  if (field.kind === "windows")
    value = text
      .split("\n")
      .filter((v) => v.trim())
      .map((line) => {
        const match = /^([A-Za-z,]+)\s+(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(line.trim());
        if (!match) throw new Error("Use Mon,Tue 09:00-17:00, one window per line.");
        const selectedDays = match[1]
          .split(",")
          .map((day) => days.findIndex((d) => d.toLowerCase() === day.toLowerCase()));
        if (selectedDays.includes(-1) || Number(match[3]) > 59 || Number(match[5]) > 59)
          throw new Error("Use valid weekday names and minutes from 00 through 59.");
        return {
          days: selectedDays,
          startMinute: Number(match[2]) * 60 + Number(match[3]),
          endMinute: Number(match[4]) * 60 + Number(match[5]),
        };
      });
  const parts = field.path.split(".");
  let target = next as unknown as Record<string, unknown>;
  for (const key of parts.slice(0, -1)) target = target[key] as Record<string, unknown>;
  target[parts[parts.length - 1]] = value;
  return pipelinePolicySchema.parse(next);
}
function clock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}
