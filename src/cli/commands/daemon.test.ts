import { describe, expect, test } from "bun:test";
import { renderDaemonStatusFrame } from "./daemon";

describe("renderDaemonStatusFrame", () => {
  test("surfaces model mismatch details at the top level", () => {
    const event = renderDaemonStatusFrame({
      id: "req-1",
      type: "result",
      ok: true,
      probe: {
        status: "mismatch",
        configuredModel: "configured-model",
        loadedModel: "loaded-model",
        message: "model mismatch: configured configured-model; loaded model loaded-model",
      },
    });

    expect(event.type).toBe("rpc:result");
    expect(event.modelStatus).toBe("mismatch");
    expect(event.configuredModel).toBe("configured-model");
    expect(event.loadedModel).toBe("loaded-model");
    expect(event.modelWarning).toBe(
      "model mismatch: configured configured-model; loaded model loaded-model",
    );
  });

  test("renders matching models without a warning field", () => {
    const event = renderDaemonStatusFrame({
      id: "req-1",
      type: "result",
      ok: true,
      probe: {
        status: "ok",
        configuredModel: "configured-model",
        loadedModel: "configured-model",
        message: "configured model configured-model is loaded",
      },
    });

    expect(event.modelStatus).toBe("ok");
    expect(event.configuredModel).toBe("configured-model");
    expect(event.loadedModel).toBe("configured-model");
    expect(event.modelWarning).toBeUndefined();
  });
});
