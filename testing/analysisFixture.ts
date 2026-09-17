import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { contentRevision } from "../src/api/notes";

export const analysisFiles = {
  "Work/Storage café.md":
    "# Storage café 😀\r\n\r\nThe storage service acknowledges a write only after three replicas persist it.\r\n",
  "Work/Storage experiment.md":
    "# Storage experiment\n\nThe storage experiment acknowledges a write after one replica persists it; it assumes disposable test data.\n",
  "Private.md": "Never include this private canary in a scoped comparison.",
};
export const analysisSources = Object.entries(analysisFiles)
  .slice(0, 2)
  .map(([path, body]) => ({ path, revision: contentRevision(body) }));
export function analysisProvider() {
  type Request = {
    response_format?: { json_schema?: { name?: string } };
    messages: Array<{ role: string; content: string }>;
    max_tokens: number;
  };
  const requests: Request[] = [];
  let mode:
    | "normal"
    | "invalid-quote"
    | "truncated"
    | "reasoning-only"
    | "abstain"
    | "repair"
    | "repair-evidence"
    | "over-budget"
    | "wait" = "normal";
  let beforeAnswer: (() => Promise<void>) | undefined;
  let cancelled = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 30,
    fetch: async (request) => {
      if (request.method === "GET")
        return Response.json({ data: [{ id: "comparison-test", state: "loaded" }] });
      const input = (await request.json()) as Request;
      requests.push(input);
      if (mode === "wait")
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"pending":'));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      const data = JSON.parse(
        input.messages.find((message) => message.role === "user")?.content ?? "{}",
      );
      const documents = data.documents as Array<{ index: number; path: string; content: string }>;
      const evidence = documents.slice(0, 2).map((document) => ({
        note: document.index,
        quote:
          document.content.split(/\r?\n/).find((line) => line.startsWith("The storage")) ??
          document.content,
      }));
      if (mode === "invalid-quote") evidence[0].quote = "This claim was invented.";
      const report = {
        comparisons: [
          {
            source: 0,
            target: 1,
            judgment: mode === "abstain" ? "insufficient" : "different-assumptions",
            assessment: mode === "abstain" ? 0 : 0.9,
            explanation:
              mode === "abstain"
                ? "The supplied passages do not establish matching guarantees."
                : "**Different assumptions:** the experiment accepts disposable data; the storage service requires three durable replicas.",
            evidence,
          },
        ],
        abstention: null,
      };
      if (mode === "repair-evidence" && input.messages.length === 2)
        report.comparisons[0].evidence.pop();
      if (mode === "repair" && input.messages.length === 2) report.comparisons[0].assessment = 90;
      const brief = input.response_format?.json_schema?.name === "knowledge_brief";
      const briefReport = {
        summary:
          mode === "abstain"
            ? null
            : {
                text: "The storage notes describe different durability assumptions.",
                evidence: evidence.slice(0, 1),
              },
        findings:
          mode === "abstain"
            ? []
            : [
                {
                  kind: "claim",
                  text: "The saved service requires durable replicas.",
                  evidence: evidence.slice(0, 1),
                },
              ],
        abstention:
          mode === "abstain" ? "The passages do not establish the requested topic." : null,
      };
      if (brief && mode === "repair-evidence" && input.messages.length === 2 && briefReport.summary)
        briefReport.summary.evidence = [
          { note: 0, quote: "Invented quotation for bounded repair." },
        ];
      const response = brief ? briefReport : report;
      await beforeAnswer?.();
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              content: mode === "reasoning-only" ? "" : JSON.stringify(response),
              reasoning_content: "Private synthetic reasoning; never final evidence.",
            },
            finish_reason: mode === "truncated" ? "length" : "stop",
          },
        ],
        usage: {
          prompt_tokens: 200,
          completion_tokens: 100,
          total_tokens: mode === "over-budget" ? 130000 : 300,
          completion_tokens_details: { reasoning_tokens: 70 },
        },
      });
    },
  });
  return {
    requests,
    get cancelled() {
      return cancelled;
    },
    setMode(value: typeof mode) {
      mode = value;
    },
    beforeAnswer(callback?: () => Promise<void>) {
      beforeAnswer = callback;
    },
    async configure(root: string) {
      await mkdir(join(root, ".notient"), { recursive: true });
      await mkdir(join(root, "Work"), { recursive: true });
      for (const [path, body] of Object.entries(analysisFiles))
        await writeFile(join(root, path), body);
      await writeFile(
        join(root, ".notient/.env"),
        `NOTIENT_LLM_BASE_URL=http://127.0.0.1:${server.port}/v1\nNOTIENT_LLM_MODEL=comparison-test\n`,
      );
    },
    stop() {
      server.stop(true);
    },
  };
}
