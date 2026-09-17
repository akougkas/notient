/** Bounded, read-only real-vault probe. Does not count as seven-pipeline acceptance. */
import { mkdir, writeFile } from "node:fs/promises";
import { FsVault } from "../src/adapters/fsVault";
import { NoteReadService } from "../src/api/notes";
import { ReasoningScheduler } from "../src/core/coordinator/reasoningScheduler";
import { Extractor } from "../src/core/indexer/extractor";
import { LMStudioProvider } from "../src/core/llm/lmStudioProvider";

const vaultPath = process.argv[2];
const notePath = process.argv[3];
const outputPath = process.argv[4];
if (!vaultPath || !notePath || !outputPath)
  throw new Error(
    "usage: bun tools/evaluate-v010-read-extract.ts <vault> <note> <output-directory>",
  );
await mkdir(outputPath, { recursive: true, mode: 0o700 });
const nativeFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await nativeFetch(input, init);
    if (String(input).endsWith("/chat/completions")) {
      const payload: unknown = await response.clone().json();
      await writeFile(`${outputPath}/provider-response.json`, JSON.stringify(payload, null, 2), {
        mode: 0o600,
      });
    }
    return response;
  },
  { preconnect: nativeFetch.preconnect },
);
const endpoint = process.env.NOTIENT_LLM_BASE_URL;
const model = process.env.NOTIENT_LLM_MODEL;
if (!endpoint || !model)
  throw new Error("set NOTIENT_LLM_BASE_URL and NOTIENT_LLM_MODEL to the endpoint under test");
const provider = new LMStudioProvider({ baseUrl: endpoint });
const service = new NoteReadService(new FsVault(vaultPath));
const note = await service.read({ path: notePath });
const selected = await service.read({
  path: notePath,
  revision: note.note.revision,
  selector: { kind: "range", start: 0, end: Math.min(6000, note.body.length) },
});
if (!selected.selected) throw new Error("missing selected source");
const source = selected.selected;
const extractor = new Extractor(provider, {
  model,
  concurrency: 1,
  windowTokens: 3000,
  maxOutputTokens: 4096,
  scheduler: new ReasoningScheduler({ maxConcurrent: 1 }),
});
await mkdir(outputPath, { recursive: true, mode: 0o700 });
await writeFile(
  `${outputPath}/input.json`,
  JSON.stringify(
    { endpoint, model, source },
    null,
    2,
  ),
  { mode: 0o600 },
);
const started = performance.now();
try {
  const extraction = await extractor.extract(
    [
      {
        id: `source-${source.revision}`,
        ord: 0,
        text: source.quote,
        tokenEstimate: Math.ceil(source.quote.length / 4),
      },
    ],
    AbortSignal.timeout(120000),
  );
  const report = {
    outcome: "completed",
    durationMs: Math.round(performance.now() - started),
    source: { path: source.path, revision: source.revision, range: source.range },
    extraction,
  };
  await writeFile(`${outputPath}/result.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(
    JSON.stringify({
      outcome: report.outcome,
      durationMs: report.durationMs,
      entities: extraction.entities.length,
      claims: extraction.claims.length,
      questions: extraction.questions.length,
      outputPath,
    }),
  );
} catch (error) {
  const report = {
    outcome: "failed",
    durationMs: Math.round(performance.now() - started),
    error: error instanceof Error ? error.message : String(error),
  };
  await writeFile(`${outputPath}/result.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report));
  process.exitCode = 1;
}
