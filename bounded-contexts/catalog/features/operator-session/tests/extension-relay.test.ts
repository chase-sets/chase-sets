import { describe, expect, it, vi } from "vitest";
import type { OperatorAdapters } from "../domain/extension/background";
import { createOperatorBackground } from "../domain/extension/background";
import { createOperatorSandboxSetNamesRequest, installOperatorBridge } from "../domain/extension/bridge";
import type { SetNamesRequestResult } from "../domain/extension/set-names/probe";

const extensionId = "ghemdloifdkoadnapmigabiekchlholm";
const extensionOrigin = `chrome-extension://${extensionId}`;
const endpointBody = JSON.stringify({ errors: [], results: [] });

function adapters(setNames?: OperatorAdapters["setNames"]): OperatorAdapters {
  return {
    storage: { trust: async () => undefined, read: async () => undefined, write: async () => undefined },
    badge: async () => undefined,
    fetch: globalThis.fetch,
    setNames,
  };
}

function background(setNames?: OperatorAdapters["setNames"]) {
  return createOperatorBackground(adapters(setNames));
}

function sender(overrides: Partial<{ id: string; url: string; origin: string; hasTab: boolean }> = {}) {
  return {
    id: extensionId,
    url: `${extensionOrigin}/popup.html`,
    origin: extensionOrigin,
    hasTab: false,
    ...overrides,
  };
}

function validResult(): SetNamesRequestResult {
  return { ok: true, status: 200, contentClass: "json", bytes: endpointBody.length, body: { errors: [], results: [] } };
}

type MessageHandler = (event: MessageEvent<unknown>) => void;

function windows() {
  const popupListeners = new Set<MessageHandler>();
  const frameListeners = new Set<MessageHandler>();
  const frameMessages: unknown[] = [];
  const popup = {
    addEventListener: (_type: "message", listener: MessageHandler) => popupListeners.add(listener),
    removeEventListener: (_type: "message", listener: MessageHandler) => popupListeners.delete(listener),
    postMessage(data: unknown, _targetOrigin: string) {
      for (const listener of popupListeners) listener({ data, source: frame, origin: "null" } as MessageEvent<unknown>);
    },
  } as unknown as Window;
  const frame = {
    parent: popup,
    addEventListener: (_type: "message", listener: MessageHandler) => frameListeners.add(listener),
    removeEventListener: (_type: "message", listener: MessageHandler) => frameListeners.delete(listener),
    postMessage(data: unknown, _targetOrigin: string) {
      frameMessages.push(data);
      for (const listener of frameListeners)
        listener({ data, source: popup, origin: extensionOrigin } as MessageEvent<unknown>);
    },
  } as unknown as Window;
  return { popup, frame, frameMessages };
}

describe("operator extension SetNames relay", () => {
  it("invokes the adapter once with the id and returns its validated result", async () => {
    const result = validResult();
    const setNames = vi.fn(async () => result);
    await expect(
      background(setNames).receiveSetNames({ action: "probe-set-names", productLineId: "3" }, sender(), extensionId),
    ).resolves.toEqual(result);
    expect(setNames).toHaveBeenCalledExactlyOnceWith("3");
  });

  it.each([
    ["foreign sender id", { id: "foreign" }],
    ["wrong popup url", { url: `${extensionOrigin}/other.html` }],
    ["wrong origin", { origin: "chrome-extension://other" }],
    ["tab sender", { hasTab: true }],
  ])("refuses %s without invoking the adapter", async (_label, senderOverride) => {
    const setNames = vi.fn(async () => validResult());
    const result = await background(setNames).receiveSetNames(
      { action: "probe-set-names", productLineId: "3" },
      sender(senderOverride),
      extensionId,
    );
    expect(result).toBeNull();
    expect(setNames).not.toHaveBeenCalled();
  });

  it.each([
    ["extra key", { action: "probe-set-names", productLineId: "3", id: 1 }],
    ["non-digit id", { action: "probe-set-names", productLineId: "3x" }],
    ["empty id", { action: "probe-set-names", productLineId: "" }],
  ])("refuses %s without invoking the adapter", async (_label, message) => {
    const setNames = vi.fn(async () => validResult());
    const result = await background(setNames).receiveSetNames(message, sender(), extensionId);
    expect(result).toBeNull();
    expect(setNames).not.toHaveBeenCalled();
  });

  it("refuses a missing or non-function adapter before invocation, and an invalid result", async () => {
    expect(
      await background().receiveSetNames({ action: "probe-set-names", productLineId: "3" }, sender(), extensionId),
    ).toBeNull();
    expect(
      await background("not-a-function" as unknown as OperatorAdapters["setNames"]).receiveSetNames(
        { action: "probe-set-names", productLineId: "3" },
        sender(),
        extensionId,
      ),
    ).toBeNull();
    const invalid = vi.fn(async () => ({ ok: "yes" }) as unknown as SetNamesRequestResult);
    expect(
      await background(invalid).receiveSetNames(
        { action: "probe-set-names", productLineId: "3" },
        sender(),
        extensionId,
      ),
    ).toBeNull();
    expect(invalid).toHaveBeenCalledTimes(1);
  });

  it("composes the sandbox request, popup bridge, service worker and frame reply", async () => {
    const setNames = vi.fn(async (productLineId: string) => {
      expect(productLineId).toBe("3");
      return validResult();
    });
    const serviceWorker = background(setNames);
    const { popup, frame, frameMessages } = windows();
    const teardown = installOperatorBridge(popup, { contentWindow: frame } as HTMLIFrameElement, (message) =>
      serviceWorker.receiveSetNames(message, sender(), extensionId),
    );
    const request = createOperatorSandboxSetNamesRequest(frame, extensionOrigin);
    await expect(request("3")).resolves.toMatchObject({ ok: true, status: 200, contentClass: "json" });
    expect(frameMessages).toHaveLength(1);
    expect(frameMessages[0]).toMatchObject({ id: 1, result: { ok: true, status: 200, contentClass: "json" } });
    expect(setNames).toHaveBeenCalledExactlyOnceWith("3");
    teardown();
  });
});
