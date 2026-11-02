import { afterEach, describe, expect, it, vi } from "vitest";
import { chromeListener } from "../src/adapters/chrome-listener";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chromeListener", () => {
  it("reports a rejected listener to global error handling and returns nothing to Chrome", async () => {
    const reportError = vi.fn();
    vi.stubGlobal("reportError", reportError);
    const failure = new Error("synthetic-listener-failure");
    const listener = vi.fn(async (_alarm: Readonly<{ name: string }>) => {
      throw failure;
    });

    expect(chromeListener(listener)({ name: "connector-work" })).toBeUndefined();
    await vi.waitFor(() => expect(reportError).toHaveBeenCalledWith(failure));
    expect(listener).toHaveBeenCalledWith({ name: "connector-work" });
  });

  it("reports nothing when the listener settles", async () => {
    const reportError = vi.fn();
    vi.stubGlobal("reportError", reportError);
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => (settle = resolve));
    const listener = vi.fn(async () => {
      settle();
    });

    chromeListener(listener)();
    await settled;
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(reportError).not.toHaveBeenCalled();
  });
});
