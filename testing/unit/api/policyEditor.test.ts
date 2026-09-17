import { expect, test } from "bun:test";
import { defaultPipelinePolicy } from "../../../src/api/background";
import type { PolicyField } from "../../../src/api/policyEditor";
import { editPolicyField, policyFieldText, policyFields } from "../../../src/api/policyEditor";
import { validatePipelinePolicy } from "../../../src/api/policyValidation";

test("human schedule text round trips exact weekdays, timezone and split midnight windows", () => {
  const policy = defaultPipelinePolicy("enrich");
  const field = requiredField(policyFields("enrich"), "windows");
  const next = editPolicyField(policy, field, "Mon,Fri 22:00-24:00\nTue,Sat 00:00-02:30");
  expect(next.windows).toEqual([
    { days: [1, 5], startMinute: 1320, endMinute: 1440 },
    { days: [2, 6], startMinute: 0, endMinute: 150 },
  ]);
  expect(policyFieldText(next, field)).toBe("Mon,Fri 22:00-24:00\nTue,Sat 00:00-02:30");
  for (const bad of ["Mon 22:00-02:00", "Tue 23:70-24:00", "Bad 09:00-10:00", "Sun 24:00-25:00"])
    expect(() => editPolicyField(policy, field, bad)).toThrow();
  expect(policy.windows).toEqual([]);
});
test("scope paths with commas remain whole and invalid numeric edits cannot become zero", () => {
  const policy = defaultPipelinePolicy("archive");
  const fields = policyFields("archive");
  const scoped = editPolicyField(
    policy,
    requiredField(fields, "readScope.paths"),
    "A, B.md\nResearch/Notes.md",
  );
  expect(scoped.readScope.paths).toEqual(["A, B.md", "Research/Notes.md"]);
  const seconds = requiredField(fields, "intervalMs");
  expect(editPolicyField(policy, seconds, "3600").intervalMs).toBe(3600000);
  expect(() => editPolicyField(policy, seconds, "")).toThrow();
  expect(() => editPolicyField(policy, seconds, "-1")).toThrow();
});
test("semantic permissions explain broad scope and refuse enabled work without triggers or unsupported effects", () => {
  const policy = defaultPipelinePolicy("enrich");
  const defaults = validatePipelinePolicy("enrich", policy);
  expect(defaults.valid).toBe(true);
  expect(
    defaults.issues.some((issue) => issue.path === "readScope" && issue.severity === "warning"),
  ).toBe(true);
  expect(validatePipelinePolicy("enrich", { ...policy, enabled: true }).valid).toBe(false);
  expect(
    validatePipelinePolicy("enrich", { ...policy, mode: "apply", effects: ["archive"] }).valid,
  ).toBe(false);
  expect(
    validatePipelinePolicy("enrich", {
      ...policy,
      enabled: true,
      triggers: ["save"],
      mode: "apply",
      effects: ["properties"],
    }).valid,
  ).toBe(true);
});

function requiredField(fields: PolicyField[], path: string) {
  const field = fields.find((field) => field.path === path);
  if (!field) throw new Error(`Missing ${path}`);
  return field;
}
