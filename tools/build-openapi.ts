import { createOpenApiDocument } from "../src/api/openapi";
await Bun.write("docs/openapi-v1.json", `${JSON.stringify(createOpenApiDocument(), null, 2)}\n`);
