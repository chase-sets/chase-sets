// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { installOperatorBridge } from "../../domain/extension/bridge";
import { syntheticGrant } from "./fixture";

describe("operator-extension sandbox source boundary", () => {
  it("requires exact frame, opaque origin and recursively closed request before send", async () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const send = vi.fn(async () => null);
    const dispose = installOperatorBridge(window, frame, send);
    const command = { action: "pair", environment: "staging", grant: syntheticGrant };
    for (const input of [
      { source: window, origin: "null", data: { id: 1, command } },
      { source: frame.contentWindow, origin: "https://evil.test", data: { id: 1, command } },
      { source: frame.contentWindow, origin: "null", data: { id: 1, command: { ...command, nested: {} } } },
      { source: frame.contentWindow, origin: "null", data: { id: 1.5, command } },
    ])
      window.dispatchEvent(new MessageEvent("message", input));
    expect(send).not.toHaveBeenCalled();
    window.dispatchEvent(
      new MessageEvent("message", { source: frame.contentWindow, origin: "null", data: { id: 1, command } }),
    );
    expect(send).toHaveBeenCalledTimes(1);
    dispose();
    frame.remove();
  });
});
