import { z } from "zod";
import { operationInputs } from "./operations";
import { type ImplementedOperation, operationOutputs } from "./results";

/** Generated from the same runtime contracts used by the daemon and SDK. */
export function createOpenApiDocument() {
  const paths: Record<string, unknown> = {};
  for (const name of Object.keys(operationOutputs) as ImplementedOperation[]) {
    paths[`/api/v1/${name.replaceAll(".", "/")}`] = {
      post: {
        operationId: name,
        summary: name.replaceAll(".", " "),
        security: [{ scopedBearer: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: z.toJSONSchema(operationInputs[name], { io: "input" }) },
          },
        },
        responses: {
          "200": {
            description:
              "Runtime-validated operation result; inspect result state for partial or denied effects.",
            content: { "application/json": { schema: z.toJSONSchema(operationOutputs[name]) } },
          },
          default: {
            description:
              "Structured failure. A disconnected mutation can have an unknown outcome; reuse its original idempotency identity after inspection.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["error", "correlationId"],
                  properties: {
                    error: {
                      type: "object",
                      required: ["code", "message"],
                      properties: { code: { type: "string" }, message: { type: "string" } },
                    },
                    correlationId: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    };
  }
  paths["/api/v1/events"] = {
    get: {
      operationId: "events.stream",
      summary: "Resume persisted events using Last-Event-ID",
      security: [{ scopedBearer: [] }],
      parameters: [
        { in: "header", name: "Last-Event-ID", schema: { type: "string" }, required: false },
      ],
      responses: {
        "200": {
          description:
            "Bounded SSE pages; event ids match payload ids. Reconnect with the last processed cursor.",
          content: { "text/event-stream": { schema: { type: "string" } } },
        },
        "409": { description: "Cursor expired. Refresh current state before resubscribing." },
      },
    },
  };
  paths["/api/v1/pair"] = {
    post: {
      operationId: "pairing.exchange",
      summary: "Exchange one local operator-issued code for a vault-bound credential",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["code", "vaultId"],
              properties: { code: { type: "string", maxLength: 128 }, vaultId: { type: "string" } },
            },
          },
        },
      },
      responses: {
        "200": { description: "Single-use bearer token; store in client-local private storage." },
        "401": { description: "Code invalid, expired, consumed, or for another vault." },
      },
    },
  };
  return {
    openapi: "3.1.0",
    info: {
      title: "Notient note API",
      version: "v1",
      description:
        "Exact vault-relative Markdown paths; revisions are SHA-256 of UTF-8 file content; source offsets are UTF-16 code units. Scope filters intersect. Loopback only. Credentials are issued through notient pair create and never sent as query parameters.",
    },
    servers: [
      {
        url: "http://127.0.0.1:{port}",
        variables: {
          port: {
            default: "12345",
            description: "Use the endpoint printed by notient pair create.",
          },
        },
      },
    ],
    components: {
      securitySchemes: {
        scopedBearer: {
          type: "http",
          scheme: "bearer",
          description: "Per-vault, revocable, explicitly paired credential.",
        },
      },
    },
    paths,
  };
}
