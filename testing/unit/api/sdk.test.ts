import { expect, test } from "bun:test";
import pkg from "../../../package.json";
import * as sdk from "../../../src/api/sdk";

test("the published SDK entry exposes the client, its error and the operation catalog", () => {
  expect(Object.keys(sdk).sort()).toEqual([
    "NotientApiError",
    "NotientClient",
    "apiErrorCodeSchema",
    "capabilitiesSchema",
    "eventSchema",
    "operationInputs",
    "operationOutputs",
    "pairingResultSchema",
  ]);
  expect(Object.keys(sdk.operationOutputs).every((name) => name in sdk.operationInputs)).toBe(true);
  expect(pkg.exports["./sdk"]).toEqual({
    types: "./dist/sdk/types/api/sdk.d.ts",
    import: "./dist/sdk/index.js",
  });
});

test("the SDK bundle is browser-safe and leaves only zod external", async () => {
  const built = await Bun.build({
    entrypoints: ["src/api/sdk.ts"],
    target: "browser",
    format: "esm",
    external: ["zod"],
  });
  expect(built.success).toBe(true);
  const code = await built.outputs[0].text();
  const imports = [...code.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
  expect([...new Set(imports)]).toEqual(["zod"]);
  expect(code).not.toMatch(/\b(node:|Bun\.)/);
});
