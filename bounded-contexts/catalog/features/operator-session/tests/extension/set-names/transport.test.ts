import { describe, expect, it, vi } from "vitest";
import { createOperatorBackground, type OperatorAdapters } from "../../../domain/extension/background";
import { createOperatorPopupClient, installOperatorBridge } from "../../../domain/extension/bridge";
import { operatorExtensionId, operatorOrigins } from "../../../domain/extension/protocol";
import { createOperatorTransport } from "../../../domain/extension/transport";
import { counts, post } from "./fixture";

const grant = "A".repeat(43);
const origin = `chrome-extension://${operatorExtensionId}`;
const sender = { id: operatorExtensionId, url: `${origin}/popup.html`, origin, hasTab: false };
const message = () => ({ action: "post-set-names", environment: "staging", post: post() });
function setup(status = 200, body: unknown = counts) {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  const writes: unknown[] = [];
  const badge = vi.fn(async () => undefined);
  const adapters: OperatorAdapters = {
    storage: {
      trust: async () => undefined,
      read: async () => undefined,
      write: async (_key, value) => {
        writes.push(value);
      },
    },
    badge,
    fetch: fetcher,
  };
  return { background: createOperatorBackground(adapters), fetcher, writes, badge };
}

describe("SetNames grant transport", () => {
  it("posts exactly once with the existing environment grant and closed response counts", async () => {
    const { background, fetcher, writes } = setup();
    await background.receive({ action: "pair", environment: "staging", grant }, sender, operatorExtensionId);
    const before = writes.length;
    await expect(background.receiveSetNamePost(message(), sender, operatorExtensionId)).resolves.toEqual({
      outcome: "recorded",
      ...counts,
    });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      `${operatorOrigins.staging}/api/public/catalog/operator-session/scope-observations/tcgplayer-set-names`,
      {
        method: "POST",
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        headers: { Authorization: `Bearer ${grant}`, "Content-Type": "application/json" },
        body: JSON.stringify(post()),
      },
    );
    expect(writes).toHaveLength(before);
  });
  it.each([401, 403])(
    "turns %s into re-pair-required with no retry, response read or provider persistence",
    async (status) => {
      const { background, fetcher, writes, badge } = setup(status, {
        error: "Cookie TCGAuthTicket=private Bearer private",
      });
      await background.receive({ action: "pair", environment: "staging", grant }, sender, operatorExtensionId);
      expect(await background.receiveSetNamePost(message(), sender, operatorExtensionId)).toEqual({
        outcome: "grant-invalid",
      });
      expect(
        await background.receive({ action: "status", environment: "staging" }, sender, operatorExtensionId),
      ).toMatchObject({ paired: false, state: "re-pair-required" });
      expect(await background.receiveSetNamePost(message(), sender, operatorExtensionId)).toEqual({
        outcome: "grant-invalid",
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(badge).toHaveBeenLastCalledWith(true);
      expect(JSON.stringify(writes)).not.toMatch(/Synthetic|TCGAuthTicket|private|cleanSetName/);
    },
  );
  it.each([{ id: "foreign" }, { url: `${origin}/sandbox.html` }, { origin: "null" }, { hasTab: true }])(
    "refuses an untrusted sender %j without fetching",
    async (override) => {
      const { background, fetcher } = setup();
      await expect(
        background.receiveSetNamePost(message(), { ...sender, ...override }, operatorExtensionId),
      ).resolves.toBeNull();
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("refuses extra keys, invalid posts, unbound ids and missing environment grants", async () => {
    const { background, fetcher } = setup();
    for (const candidate of [
      { ...message(), extra: true },
      { ...message(), post: { ...post(), productLineId: 71 } },
      { ...message(), post: { ...post(), sets: [] } },
    ]) {
      expect(await background.receiveSetNamePost(candidate, sender, operatorExtensionId)).toBeNull();
    }
    expect(await background.receiveSetNamePost(message(), sender, operatorExtensionId)).toEqual({
      outcome: "grant-invalid",
    });
    await background.receive({ action: "pair", environment: "production", grant }, sender, operatorExtensionId);
    expect(await background.receiveSetNamePost(message(), sender, operatorExtensionId)).toEqual({
      outcome: "grant-invalid",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    [200, { ...counts, extra: "Bearer private" }, "invalid-response"],
    [200, { ...counts, observationCount: "1" }, "invalid-response"],
    [200, { ...counts, mappingsProposed: -1 }, "invalid-response"],
    [400, { error: "TCGAuthTicket=private" }, "refused"],
    [503, { error: "Cookie private" }, "unavailable"],
  ])("classifies Catalog %s without returning body values", async (status, body, outcome) => {
    const { fetcher } = setup(status, body);
    expect(await createOperatorTransport(fetcher).postSetNames("staging", grant, post())).toEqual({ outcome });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("never echoes a thrown exception or retries", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("Cookie TCGAuthTicket=private");
    });
    expect(await createOperatorTransport(fetcher).postSetNames("staging", grant, post())).toEqual({
      outcome: "unavailable",
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("composes the real popup client, bridge and background post path and rejects forged replies", async () => {
    type Handler = (event: MessageEvent<unknown>) => void;
    const popupListeners = new Set<Handler>();
    const frameListeners = new Set<Handler>();
    const popup = {
      addEventListener: (_type: string, handler: Handler) => popupListeners.add(handler),
      removeEventListener: (_type: string, handler: Handler) => popupListeners.delete(handler),
      postMessage(data: unknown) {
        for (const handler of popupListeners) handler({ data, source: frame, origin: "null" } as MessageEvent);
      },
    } as unknown as Window;
    const frame = {
      parent: popup,
      addEventListener: (_type: string, handler: Handler) => frameListeners.add(handler),
      removeEventListener: (_type: string, handler: Handler) => frameListeners.delete(handler),
      postMessage(data: unknown) {
        for (const handler of frameListeners) handler({ data, source: popup, origin } as MessageEvent);
      },
    } as unknown as Window;
    const { background, fetcher } = setup();
    await background.receive({ action: "pair", environment: "staging", grant }, sender, operatorExtensionId);
    const dispose = installOperatorBridge(popup, { contentWindow: frame } as HTMLIFrameElement, (value) =>
      background.receiveSetNamePost(value, sender, operatorExtensionId),
    );
    const client = createOperatorPopupClient(frame, origin);
    try {
      const pending = client.postSetNames("staging", post());
      for (const handler of frameListeners)
        handler({
          source: popup,
          origin: "https://attacker.test",
          data: { id: 1, postResult: { outcome: "refused" } },
        } as MessageEvent);
      await expect(pending).resolves.toEqual({ outcome: "recorded", ...counts });
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      client.dispose();
      dispose();
    }
  });
});
